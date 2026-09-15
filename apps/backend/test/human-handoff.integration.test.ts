import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaHumanHandoff } from '../src/ai/human-handoff-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('human handoff advances epoch once and replays idempotently', { timeout: 15000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'human handoff integration requires MIGRATION_DATABASE_URL');
  const config = parseConfig(process.env);
  const deps = new Dependencies(config);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const customerId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const idempotencyKey = `${turnId}:handoff_1`;
  const handoff = new PrismaHumanHandoff(deps);

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Human handoff fixture',
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
        externalAccountId: String(Date.now()),
        externalPhoneId: `${Date.now()}1`,
        displayName: 'Handoff channel',
        credentialsReference: 'secret://test/whatsapp',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.customer.create({
      data: {
        id: customerId,
        tenantId,
        displayName: 'Handoff customer',
        phoneE164: '+351910000098',
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
        lastMessageAt: new Date(),
      },
    });
    await admin.$executeRaw`
      INSERT INTO ai_turns (
        tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
      ) VALUES (
        ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
        ${customerId}::uuid, 7, 3
      )`;

    await assert.rejects(
      handoff.request(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 6n,
          idempotencyKey: `${turnId}:stale`,
          executionMode: 'live',
          reason: 'other',
        },
        new AbortController().signal,
      ),
      /stale/,
    );
    assert.equal(
      (
        await admin.conversation.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id: conversationId } },
        })
      ).mode,
      'AI_ACTIVE',
    );

    const first = await handoff.request(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 7n,
        idempotencyKey,
        executionMode: 'live',
        reason: 'customer_requested',
      },
      new AbortController().signal,
    );
    assert.deepEqual(first, { status: 'waiting_human', duplicate: false });

    const afterFirst = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: conversationId } },
    });
    assert.equal(afterFirst.mode, 'WAITING_HUMAN');
    assert.equal(afterFirst.modeEpoch, 8n);
    const [requestCount] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM ai_handoff_requests
      WHERE tenant_id=${tenantId}::uuid AND idempotency_key=${idempotencyKey}`;
    assert.equal(requestCount?.count, 1n);
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, action: 'ai.handoff_requested', targetId: conversationId },
      }),
      1,
    );

    const replay = await handoff.request(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 7n,
        idempotencyKey,
        executionMode: 'live',
        reason: 'customer_requested',
      },
      new AbortController().signal,
    );
    assert.deepEqual(replay, { status: 'waiting_human', duplicate: true });
    const afterReplay = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: conversationId } },
    });
    assert.equal(afterReplay.modeEpoch, 8n);
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, action: 'ai.handoff_requested', targetId: conversationId },
      }),
      1,
    );

    await assert.rejects(
      handoff.request(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 7n,
          idempotencyKey,
          executionMode: 'live',
          reason: 'complaint',
        },
        new AbortController().signal,
      ),
      /Idempotency conflict/,
    );
    await assert.rejects(
      handoff.request(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 7n,
          idempotencyKey: `${turnId}:sandbox`,
          executionMode: 'sandbox',
          reason: 'other',
        },
        new AbortController().signal,
      ),
      /live-only/,
    );
    const [finalCount] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM ai_handoff_requests WHERE tenant_id=${tenantId}::uuid`;
    assert.equal(finalCount?.count, 1n);
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
