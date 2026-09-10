import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { PrismaAITurnDispatchStore } from '../src/ai/ai-turn-processor';

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
            ${
              replay.status === 'failed' || replay.status === 'stale'
                ? 'replay_terminal'
                : null
            },
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
      assert.equal(
        await admin.auditEvent.count({ where: { tenantId, targetId: runningId } }),
        0,
      );
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
