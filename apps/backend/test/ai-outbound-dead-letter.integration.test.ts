import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { PrismaAITurnLedgerRepository } from '../src/ai/ai-turn-ledger';
import { PrismaAIAutomaticOutboundStore } from '../src/ai/ai-outbound-dispatcher';
import { recordAIAutomaticDeliveryReceipt } from '../src/messaging/receipt-state';

test(
  'outbound dead letters are terminal, idempotent, and tenant scoped',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl);
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const channelId = randomUUID();
    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'DLQ fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'DLQ customer',
          phoneE164: '+351910000093',
        },
      });
      await admin.channelConnection.create({
        data: {
          id: channelId,
          tenantId,
          channelType: 'whatsapp',
          mode: 'live',
          externalAccountId: randomUUID(),
          externalPhoneId: String(Date.now()),
          displayName: 'DLQ channel',
          credentialsReference: 'secret://test/dlq',
          webhookSecretReference: 'secret://test/dlq-webhook',
        },
      });
      await admin.conversation.create({
        data: {
          id: conversationId,
          tenantId,
          customerId,
          channelConnectionId: channelId,
          mode: 'AI_ACTIVE',
          modeEpoch: 1n,
          stateVersion: 1n,
          lastMessageAt: new Date(),
        },
      });

      const ledger = new PrismaAITurnLedgerRepository(deps);
      assert.equal(
        await ledger.begin({
          tenantId,
          turnId,
          conversationId,
          customerId,
          modeEpoch: 1n,
          stateVersion: 1n,
        }),
        'started',
      );
      assert.equal(
        await ledger.finish({
          tenantId,
          turnId,
          outcome: 'completed',
          rounds: 1,
          toolCalls: 0,
          failureCode: null,
          providerKey: 'mock',
          modelKey: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          deliveryText: 'DLQ',
        }),
        'finished',
      );
      const outbound = await admin.aiOutboundIntent.findFirstOrThrow({
        where: { tenantId, turnId },
      });
      const store = new PrismaAIAutomaticOutboundStore(deps);

      const acceptedTurnId = randomUUID();
      assert.equal(
        await ledger.begin({
          tenantId,
          turnId: acceptedTurnId,
          conversationId,
          customerId,
          modeEpoch: 1n,
          stateVersion: 1n,
        }),
        'started',
      );
      assert.equal(
        await ledger.finish({
          tenantId,
          turnId: acceptedTurnId,
          outcome: 'completed',
          rounds: 1,
          toolCalls: 0,
          failureCode: null,
          providerKey: 'mock',
          modelKey: 'mock',
          inputTokens: 1,
          outputTokens: 1,
          deliveryText: 'Receipt',
        }),
        'finished',
      );
      const acceptedOutbound = await admin.aiOutboundIntent.findFirstOrThrow({
        where: { tenantId, turnId: acceptedTurnId },
      });
      const acceptedClaim = await store.claim(acceptedOutbound.id, 0);
      assert(acceptedClaim);
      const providerMessageId = `wamid.${randomUUID()}`;
      const acceptedAt = new Date();
      await store.accept(acceptedClaim, { providerMessageId, acceptedAt });
      const [acceptedDispatch] = await admin.$queryRaw<
        Array<{ state: string; providerMessageId: string; acceptedAt: Date }>
      >`
        SELECT state, provider_message_id AS "providerMessageId",
          accepted_at AS "acceptedAt"
        FROM ai_outbound_dispatch
        WHERE tenant_id=${tenantId}::uuid AND id=${acceptedOutbound.id}::uuid`;
      assert.equal(acceptedDispatch?.state, 'accepted');
      assert.equal(acceptedDispatch?.providerMessageId, providerMessageId);
      assert.equal(acceptedDispatch?.acceptedAt.getTime(), acceptedAt.getTime());

      const sentAt = new Date(acceptedAt.getTime() + 1000);
      assert.equal(
        await recordAIAutomaticDeliveryReceipt(deps, {
          tenantId,
          providerMessageId,
          status: 'sent',
          providerTimestamp: sentAt,
        }),
        'applied',
      );
      assert.equal(
        await recordAIAutomaticDeliveryReceipt(deps, {
          tenantId,
          providerMessageId,
          status: 'sent',
          providerTimestamp: sentAt,
        }),
        'duplicate',
      );
      const deliveredAt = new Date(acceptedAt.getTime() + 2000);
      assert.equal(
        await recordAIAutomaticDeliveryReceipt(deps, {
          tenantId,
          providerMessageId,
          status: 'delivered',
          providerTimestamp: deliveredAt,
        }),
        'applied',
      );
      assert.equal(
        await recordAIAutomaticDeliveryReceipt(deps, {
          tenantId,
          providerMessageId,
          status: 'sent',
          providerTimestamp: new Date(deliveredAt.getTime() + 1000),
        }),
        'stale',
      );
      assert.equal(
        await recordAIAutomaticDeliveryReceipt(deps, {
          tenantId,
          providerMessageId: `wamid.${randomUUID()}`,
          status: 'delivered',
          providerTimestamp: deliveredAt,
        }),
        'unknown',
      );
      const [deliveryReceipt] = await admin.$queryRaw<
        { status: string; statusRank: number; providerTimestamp: Date }[]
      >`
        SELECT status, status_rank AS "statusRank",
          provider_timestamp AS "providerTimestamp"
        FROM ai_outbound_delivery_receipts
        WHERE tenant_id=${tenantId}::uuid
          AND provider_message_id=${providerMessageId}`;
      assert.equal(deliveryReceipt?.status, 'delivered');
      assert.equal(deliveryReceipt?.statusRank, 20);
      assert.equal(
        deliveryReceipt?.providerTimestamp.getTime(),
        deliveredAt.getTime(),
      );

      for (let attempt = 0; attempt < 5; attempt++) {
        await admin.aiOutboundDispatch.updateMany({
          where: { tenantId, id: outbound.id },
          data: { nextAttemptAt: new Date(0) },
        });
        const claim = await store.claim(outbound.id, attempt);
        assert(claim);
        await store.recordFailure(claim);
        assert.equal(
          await admin.aiOutboundDeadLetter.count({
            where: { tenantId, dispatchId: outbound.id },
          }),
          attempt === 4 ? 1 : 0,
        );
      }
      const deadLetter = await admin.aiOutboundDeadLetter.findFirstOrThrow({
        where: { tenantId, dispatchId: outbound.id },
      });
      assert.equal(deadLetter.reason, 'retry_exhausted');
      assert.equal(deadLetter.attempts, 5);

      const visible = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.aiOutboundDeadLetter.count({
          where: { dispatchId: outbound.id },
        });
      });
      assert.equal(visible, 1);
      const hidden = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`;
        return tx.aiOutboundDeadLetter.count({
          where: { dispatchId: outbound.id },
        });
      });
      assert.equal(hidden, 0);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
