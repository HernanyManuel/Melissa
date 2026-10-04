import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { PrismaAITurnLedgerRepository } from '../src/ai/ai-turn-ledger';
import { PrismaAITurnDispatchStore } from '../src/ai/ai-turn-processor';
import { PrismaAIAutomaticOutboundStore } from '../src/ai/ai-outbound-dispatcher';

test(
  'AI turn dispatch store enforces server-owned scope and durable retry state',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'AI turn processor integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const store = new PrismaAITurnDispatchStore(deps);
    const tenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const otherCustomerId = randomUUID();
    const conversationId = randomUUID();
    const accountId = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    const phoneId = `${accountId}7`;

    const createIntent = async (
      customer: string,
      modeEpoch = 4n,
      stateVersion = 2n,
    ): Promise<string> => {
      const batch = await admin.inboundBatch.create({
        data: {
          tenantId,
          channelId,
          customerId: customer,
          createdAt: new Date(Date.now() - 3000),
          dueAt: new Date(Date.now() - 2000),
        },
      });
      const id = randomUUID();
      await admin.$executeRaw`
        INSERT INTO ai_turn_intents
          (tenant_id, id, batch_id, conversation_id, customer_id, mode_epoch, state_version)
        VALUES (
          ${tenantId}::uuid, ${id}::uuid, ${batch.id}::uuid, ${conversationId}::uuid,
          ${customer}::uuid, ${modeEpoch}, ${stateVersion}
        )`;
      await admin.$executeRaw`
        INSERT INTO ai_turn_dispatch (id, tenant_id, next_attempt_at)
        VALUES (${id}::uuid, ${tenantId}::uuid, CURRENT_TIMESTAMP - interval '1 second')`;
      return id;
    };

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'AI turn processor fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.channelConnection.create({
        data: {
          id: channelId,
          tenantId,
          channelType: 'whatsapp',
          mode: 'live',
          externalAccountId: accountId,
          externalPhoneId: phoneId,
          displayName: 'AI processor channel',
          credentialsReference: 'secret://test/ai-processor',
          webhookSecretReference: 'secret://test/ai-processor-webhook',
        },
      });
      await admin.customer.createMany({
        data: [
          {
            id: customerId,
            tenantId,
            displayName: 'AI processor customer',
            phoneE164: '+351910000091',
          },
          {
            id: otherCustomerId,
            tenantId,
            displayName: 'Other AI processor customer',
            phoneE164: '+351910000092',
          },
        ],
      });
      await admin.conversation.create({
        data: {
          id: conversationId,
          tenantId,
          customerId,
          channelConnectionId: channelId,
          mode: 'AI_ACTIVE',
          modeEpoch: 4n,
          stateVersion: 2n,
          lastMessageAt: new Date(Date.now() - 5000),
        },
      });

      const validId = await createIntent(customerId);
      const valid = await store.claim(validId, 0);
      assert(valid);
      assert.equal(valid.tenantId, tenantId);
      assert.equal(valid.conversationId, conversationId);
      assert.equal(valid.customerId, customerId);
      assert.equal(valid.modeEpoch, 4n);
      assert.equal(valid.stateVersion, 2n);
      await store.defer(valid);
      const [deferred] = await admin.$queryRaw<
        Array<{ state: string; attempts: number; nextAttemptAt: Date }>
      >`
        SELECT state, attempts, next_attempt_at AS "nextAttemptAt"
        FROM ai_turn_dispatch WHERE id=${validId}::uuid`;
      assert.equal(deferred?.state, 'pending');
      assert.equal(deferred?.attempts, 0);
      assert(deferred && deferred.nextAttemptAt > new Date(Date.now() - 500));

      await admin.$executeRaw`
        UPDATE ai_turn_dispatch SET next_attempt_at=CURRENT_TIMESTAMP - interval '1 second'
        WHERE id=${validId}::uuid`;
      const retryClaim = await store.claim(validId, 0);
      assert(retryClaim);
      await store.recordFailure(retryClaim);
      const [retry] = await admin.$queryRaw<
        Array<{ state: string; attempts: number; nextAttemptAt: Date }>
      >`
        SELECT state, attempts, next_attempt_at AS "nextAttemptAt"
        FROM ai_turn_dispatch WHERE id=${validId}::uuid`;
      assert.equal(retry?.state, 'pending');
      assert.equal(retry?.attempts, 1);
      assert(retry && retry.nextAttemptAt > new Date());
      assert.equal(
        await admin.auditEvent.count({
          where: { tenantId, targetId: validId, action: 'ai.turn_retry' },
        }),
        1,
      );

      const mismatchedCustomerId = await createIntent(otherCustomerId);
      assert.equal(await store.claim(mismatchedCustomerId, 0), null);
      const [mismatched] = await admin.$queryRaw<Array<{ state: string }>>`
        SELECT state FROM ai_turn_dispatch WHERE id=${mismatchedCustomerId}::uuid`;
      assert.equal(mismatched?.state, 'rejected');
      assert.equal(
        await admin.auditEvent.count({
          where: { tenantId, targetId: mismatchedCustomerId, action: 'ai.turn_rejected' },
        }),
        1,
      );

      const staleEpochId = await createIntent(customerId, 3n, 2n);
      assert.equal(await store.claim(staleEpochId, 0), null);
      const [staleEpoch] = await admin.$queryRaw<Array<{ state: string }>>`
        SELECT state FROM ai_turn_dispatch WHERE id=${staleEpochId}::uuid`;
      assert.equal(staleEpoch?.state, 'rejected');

      const staleVersionId = await createIntent(customerId, 4n, 1n);
      assert.equal(await store.claim(staleVersionId, 0), null);
      const [staleVersion] = await admin.$queryRaw<Array<{ state: string }>>`
        SELECT state FROM ai_turn_dispatch WHERE id=${staleVersionId}::uuid`;
      assert.equal(staleVersion?.state, 'rejected');

      const replayCases = [
        { status: 'completed', dispatch: 'processed', action: 'ai.turn_processed' },
        { status: 'handoff_required', dispatch: 'processed', action: 'ai.turn_processed' },
        { status: 'stale', dispatch: 'rejected', action: 'ai.turn_rejected' },
        { status: 'failed', dispatch: 'failed', action: 'ai.turn_failed' },
      ] as const;
      for (const replay of replayCases) {
        const id = await createIntent(customerId);
        await admin.$executeRaw`
          INSERT INTO ai_turns
            (tenant_id, id, conversation_id, customer_id, mode_epoch, state_version,
             status, failure_code, completed_at)
          VALUES (
            ${tenantId}::uuid, ${id}::uuid, ${conversationId}::uuid, ${customerId}::uuid,
            4, 2, ${replay.status},
            ${replay.status === 'failed' || replay.status === 'stale' ? 'replay_terminal' : null},
            CURRENT_TIMESTAMP
          )`;
        const claim = await store.claim(id, 0);
        assert(claim);
        await store.settleFinished(claim);
        const [dispatch] = await admin.$queryRaw<Array<{ state: string; attempts: number }>>`
          SELECT state, attempts FROM ai_turn_dispatch WHERE id=${id}::uuid`;
        assert.deepEqual(dispatch, { state: replay.dispatch, attempts: 0 });
        assert.equal(
          await admin.auditEvent.count({
            where: { tenantId, targetId: id, action: replay.action },
          }),
          1,
        );
      }

      const runningId = await createIntent(customerId);
      await admin.$executeRaw`
        INSERT INTO ai_turns
          (tenant_id, id, conversation_id, customer_id, mode_epoch, state_version)
        VALUES (
          ${tenantId}::uuid, ${runningId}::uuid, ${conversationId}::uuid,
          ${customerId}::uuid, 4, 2
        )`;
      const runningClaim = await store.claim(runningId, 0);
      assert(runningClaim);
      await store.settleFinished(runningClaim);
      const [running] = await admin.$queryRaw<
        Array<{ state: string; attempts: number; nextAttemptAt: Date }>
      >`
        SELECT state, attempts, next_attempt_at AS "nextAttemptAt"
        FROM ai_turn_dispatch WHERE id=${runningId}::uuid`;
      assert.equal(running?.state, 'pending');
      assert.equal(running?.attempts, 0);
      assert(running && running.nextAttemptAt > new Date(Date.now() - 500));
      assert.equal(await admin.auditEvent.count({ where: { tenantId, targetId: runningId } }), 0);

      const leasedTurnId = randomUUID();
      const firstLeaseId = randomUUID();
      const secondLeaseId = randomUUID();
      const ledger = new PrismaAITurnLedgerRepository(deps);
      const leaseStart = {
        tenantId,
        turnId: leasedTurnId,
        conversationId,
        customerId,
        modeEpoch: 4n,
        stateVersion: 2n,
      };
      assert.equal(await ledger.begin({ ...leaseStart, leaseId: firstLeaseId }), 'started');
      const activeOwner = await ledger.begin({ ...leaseStart, leaseId: secondLeaseId });
      assert(activeOwner !== 'started');
      assert.equal(activeOwner.status, 'running');
      assert.equal(activeOwner.leaseId, firstLeaseId);

      await admin.$executeRaw`
        UPDATE ai_turns
        SET execution_lease_expires_at=CURRENT_TIMESTAMP - interval '1 second'
        WHERE tenant_id=${tenantId}::uuid AND id=${leasedTurnId}::uuid`;
      const reclaimed = await ledger.begin({ ...leaseStart, leaseId: secondLeaseId });
      assert(reclaimed !== 'started');
      assert.equal(reclaimed.status, 'running');
      assert.equal(reclaimed.leaseId, secondLeaseId);

      const finishBase = {
        tenantId,
        turnId: leasedTurnId,
        outcome: 'completed' as const,
        rounds: 1,
        toolCalls: 0,
        failureCode: null,
        providerKey: 'mock',
        modelKey: 'mock',
        inputTokens: 3,
        outputTokens: 2,
        deliveryText: 'lease winner',
      };
      assert.equal(await ledger.finish({ ...finishBase, leaseId: firstLeaseId }), 'stale');
      assert.equal(
        await admin.aiUsageEvent.count({ where: { tenantId, turnId: leasedTurnId } }),
        0,
      );
      assert.equal(
        await admin.aiOutboundIntent.count({ where: { tenantId, turnId: leasedTurnId } }),
        0,
      );

      assert.equal(await ledger.finish({ ...finishBase, leaseId: secondLeaseId }), 'finished');
      assert.equal(
        await admin.aiUsageEvent.count({ where: { tenantId, turnId: leasedTurnId } }),
        1,
      );
      assert.equal(
        await admin.aiOutboundIntent.count({ where: { tenantId, turnId: leasedTurnId } }),
        1,
      );

      const pricedTurnId = randomUUID();
      const pricingId = randomUUID();
      await admin.$executeRaw`
        INSERT INTO ai_model_prices (
          id, provider_key, model_key, currency,
          input_price_micros_per_million, output_price_micros_per_million, effective_from
        ) VALUES (
          ${pricingId}::uuid, 'mock', 'priced-model', 'USD', 1500000, 6000000,
          CURRENT_TIMESTAMP - interval '1 minute'
        )`;
      assert.equal(
        await ledger.begin({
          tenantId,
          turnId: pricedTurnId,
          conversationId,
          customerId,
          modeEpoch: 4n,
          stateVersion: 2n,
        }),
        'started',
      );
      assert.equal(
        await ledger.finish({
          tenantId,
          turnId: pricedTurnId,
          outcome: 'completed',
          rounds: 1,
          toolCalls: 0,
          failureCode: null,
          providerKey: 'mock',
          modelKey: 'priced-model',
          inputTokens: 1000,
          outputTokens: 500,
        }),
        'finished',
      );
      const [pricedUsage] = await admin.$queryRaw<
        Array<{
          pricingId: string | null;
          currency: string | null;
          inputPrice: bigint | null;
          outputPrice: bigint | null;
          costMicros: bigint | null;
        }>
      >`
        SELECT pricing_id::text AS "pricingId", currency,
               input_price_micros_per_million AS "inputPrice",
               output_price_micros_per_million AS "outputPrice",
               cost_micros AS "costMicros"
        FROM ai_usage_events
        WHERE tenant_id=${tenantId}::uuid AND turn_id=${pricedTurnId}::uuid`;
      assert.equal(pricedUsage?.pricingId, pricingId);
      assert.equal(pricedUsage?.currency, 'USD');
      assert.equal(pricedUsage?.inputPrice, 1500000n);
      assert.equal(pricedUsage?.outputPrice, 6000000n);
      assert.equal(pricedUsage?.costMicros, 4500n);

      await admin.$executeRaw`
        UPDATE ai_model_prices
        SET input_price_micros_per_million=9000000,
            output_price_micros_per_million=9000000
        WHERE id=${pricingId}::uuid`;
      const [historicalUsage] = await admin.$queryRaw<Array<{ costMicros: bigint | null }>>`
        SELECT cost_micros AS "costMicros"
        FROM ai_usage_events
        WHERE tenant_id=${tenantId}::uuid AND turn_id=${pricedTurnId}::uuid`;
      assert.equal(historicalUsage?.costMicros, 4500n);

      const [outbound] = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text
        FROM ai_outbound_intents
        WHERE tenant_id=${tenantId}::uuid AND turn_id=${leasedTurnId}::uuid`;
      assert(outbound);
      const outboundStore = new PrismaAIAutomaticOutboundStore(deps);
      for (let attempt = 0; attempt < 5; attempt++) {
        await admin.$executeRaw`
          UPDATE ai_outbound_dispatch
          SET next_attempt_at=CURRENT_TIMESTAMP - interval '1 second'
          WHERE tenant_id=${tenantId}::uuid AND id=${outbound.id}::uuid`;
        const claim = await outboundStore.claim(outbound.id, attempt);
        assert(claim);
        await outboundStore.recordFailure(claim);
        const deadLetterCount: number = await admin.aiOutboundDeadLetter.count({
          where: { tenantId, dispatchId: outbound.id },
        });
        assert.equal(deadLetterCount, attempt === 4 ? 1 : 0);
      }
      const [failedDispatch] = await admin.$queryRaw<
        Array<{
          state: string;
          attempts: number;
        }>
      >`
        SELECT state, attempts
        FROM ai_outbound_dispatch
        WHERE tenant_id=${tenantId}::uuid AND id=${outbound.id}::uuid`;
      assert.deepEqual(failedDispatch, { state: 'failed', attempts: 5 });
      const [deadLetter] = await admin.$queryRaw<
        Array<{ reason: string; attempts: number }>
      >`
        SELECT reason, attempts
        FROM ai_outbound_dead_letters
        WHERE tenant_id=${tenantId}::uuid AND dispatch_id=${outbound.id}::uuid`;
      assert.deepEqual(deadLetter, { reason: 'retry_exhausted', attempts: 5 });

      const runtimeVisible = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.aiOutboundDeadLetter.count({
          where: { dispatchId: outbound.id },
        });
      });
      assert.equal(runtimeVisible, 1);
      const hiddenFromOtherTenant = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`;
        return tx.aiOutboundDeadLetter.count({
          where: { dispatchId: outbound.id },
        });
      });
      assert.equal(hiddenFromOtherTenant, 0);

      const unknownTurnId = randomUUID();
      assert.equal(
        await ledger.begin({
          tenantId,
          turnId: unknownTurnId,
          conversationId,
          customerId,
          modeEpoch: 4n,
          stateVersion: 2n,
        }),
        'started',
      );
      assert.equal(
        await ledger.finish({
          ...finishBase,
          turnId: unknownTurnId,
          deliveryText: 'unknown delivery',
        }),
        'finished',
      );
      const [unknownOutbound] = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM ai_outbound_intents
        WHERE tenant_id=${tenantId}::uuid AND turn_id=${unknownTurnId}::uuid`;
      assert(unknownOutbound);
      const unknownClaim = await outboundStore.claim(unknownOutbound.id, 0);
      assert(unknownClaim);
      await outboundStore.recordUnknownDelivery(unknownClaim);
      await outboundStore.recordUnknownDelivery(unknownClaim);
      const unknownDeadLetters = await admin.aiOutboundDeadLetter.findMany({
        where: { tenantId, dispatchId: unknownOutbound.id },
      });
      assert.equal(unknownDeadLetters.length, 1);
      assert.equal(unknownDeadLetters[0]?.reason, 'delivery_unknown');
      assert.equal(unknownDeadLetters[0]?.attempts, 1);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
