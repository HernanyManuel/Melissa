import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { InboundProcessor } from '../src/messaging/inbound-processor';

interface TurnIntentRow {
  id: string;
  batchId: string;
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  stateVersion: bigint;
}

test('live AI inbound persists one durable turn trigger per batch', { timeout: 15000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'AI turn trigger integration requires MIGRATION_DATABASE_URL');
  const config = parseConfig(process.env);
  const deps = new Dependencies(config);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const customerId = randomUUID();
  const conversationId = randomUUID();
  const integrationKey = `ai_turn_${randomUUID().replaceAll('-', '')}`;
  const accountId = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  const phoneId = `${accountId}1`;

  const createInbound = async (batchId: string, text: string) => {
    const id = randomUUID();
    await admin.externalEvent.create({
      data: {
        id,
        tenantId,
        provider: 'whatsapp',
        externalEventId: `wamid.${id}`,
        eventType: 'message.received',
        payloadHash: 'a'.repeat(64),
      },
    });
    await admin.inboundOutbox.create({
      data: {
        id,
        tenantId,
        channelId,
        customerId,
        actorId: null,
        origin: 'whatsapp',
        integrationKey,
        contentText: text,
        batchId,
      },
    });
    await admin.inboundDispatch.create({
      data: { id, tenantId, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    return id;
  };

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'AI turn trigger fixture',
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
        displayName: 'AI trigger channel',
        credentialsReference: 'secret://test/whatsapp',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.$executeRaw`
      INSERT INTO whatsapp_routes
        (integration_key, account_id, phone_id, tenant_id, channel_id)
      VALUES (
        ${integrationKey}, ${accountId}, ${phoneId}, ${tenantId}::uuid, ${channelId}::uuid
      )`;
    await admin.customer.create({
      data: {
        id: customerId,
        tenantId,
        displayName: 'AI trigger customer',
        phoneE164: '+351910000099',
      },
    });
    await admin.conversation.create({
      data: {
        id: conversationId,
        tenantId,
        customerId,
        channelConnectionId: channelId,
        mode: 'AI_ACTIVE',
        modeEpoch: 7n,
        stateVersion: 3n,
        lastMessageAt: new Date(Date.now() - 5000),
      },
    });

    const batch = await admin.inboundBatch.create({
      data: {
        tenantId,
        channelId,
        customerId,
        createdAt: new Date(Date.now() - 3000),
        dueAt: new Date(Date.now() - 2000),
      },
    });
    const firstId = await createInbound(batch.id, 'Primeira mensagem');
    const secondId = await createInbound(batch.id, 'Segunda mensagem');
    const processor = new InboundProcessor(deps);
    await processor.process(firstId);
    await processor.process(secondId);

    const intents = await admin.$queryRaw<TurnIntentRow[]>`
      SELECT id, batch_id AS "batchId", conversation_id AS "conversationId",
        customer_id AS "customerId", mode_epoch AS "modeEpoch", state_version AS "stateVersion"
      FROM ai_turn_intents
      WHERE tenant_id=${tenantId}::uuid AND batch_id=${batch.id}::uuid`;
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.conversationId, conversationId);
    assert.equal(intents[0]!.customerId, customerId);
    assert.equal(intents[0]!.modeEpoch, 7n);
    assert.equal(intents[0]!.stateVersion, 3n);
    const [dispatch] = await admin.$queryRaw<Array<{ state: string; attempts: number }>>`
      SELECT state, attempts FROM ai_turn_dispatch WHERE id=${intents[0]!.id}::uuid`;
    assert.deepEqual(dispatch, { state: 'pending', attempts: 0 });
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, action: 'ai.turn_queued', targetId: intents[0]!.id },
      }),
      1,
    );

    await admin.conversation.update({
      where: { tenantId_id: { tenantId, id: conversationId } },
      data: { mode: 'AI_PAUSED', modeEpoch: 8n },
    });
    const pausedBatch = await admin.inboundBatch.create({
      data: {
        tenantId,
        channelId,
        customerId,
        createdAt: new Date(Date.now() - 3000),
        dueAt: new Date(Date.now() - 2000),
      },
    });
    const pausedId = await createInbound(pausedBatch.id, 'Sem resposta automática');
    await processor.process(pausedId);
    const [paused] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM ai_turn_intents
      WHERE tenant_id=${tenantId}::uuid AND batch_id=${pausedBatch.id}::uuid`;
    assert.equal(paused?.count, 0n);
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
