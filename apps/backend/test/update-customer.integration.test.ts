import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaCustomerUpdater } from '../src/ai/update-customer-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('update_customer is fenced, durable and replay-safe', { timeout: 15000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'update customer integration requires MIGRATION_DATABASE_URL');
  const config = parseConfig(process.env);
  const deps = new Dependencies(config);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const customerId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const idempotencyKey = `${turnId}:update_1`;
  const updater = new PrismaCustomerUpdater(deps);

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Customer update fixture',
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
        externalPhoneId: `${Date.now()}2`,
        displayName: 'Customer update channel',
        credentialsReference: 'secret://test/whatsapp',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.customer.create({
      data: {
        id: customerId,
        tenantId,
        displayName: 'Before update',
        phoneE164: '+351910000097',
        email: 'before@example.com',
        language: 'pt',
        notes: 'must remain private and unchanged',
        marketingConsentStatus: 'unknown',
        whatsappOptInStatus: 'unknown',
      },
    });
    await admin.conversation.create({
      data: {
        id: conversationId,
        tenantId,
        customerId,
        channelConnectionId: channelId,
        mode: 'AI_ACTIVE',
        modeEpoch: 11n,
        stateVersion: 4n,
        lastMessageAt: new Date(),
      },
    });
    await admin.$executeRaw`
      INSERT INTO ai_turns (
        tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
      ) VALUES (
        ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
        ${customerId}::uuid, 11, 4
      )`;

    const first = await updater.update(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 11n,
        idempotencyKey,
        executionMode: 'live',
        patch: { displayName: 'After update' },
      },
      new AbortController().signal,
    );
    assert.deepEqual(first, { status: 'updated', duplicate: false });

    const afterFirst = await admin.customer.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: customerId } },
    });
    assert.equal(afterFirst.displayName, 'After update');
    assert.equal(afterFirst.phoneE164, '+351910000097');
    assert.equal(afterFirst.notes, 'must remain private and unchanged');
    assert.equal(afterFirst.marketingConsentStatus, 'unknown');
    assert.equal(afterFirst.whatsappOptInStatus, 'unknown');
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, action: 'ai.customer_updated', targetId: customerId },
      }),
      1,
    );

    const replay = await updater.update(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 11n,
        idempotencyKey,
        executionMode: 'live',
        patch: { displayName: 'After update' },
      },
      new AbortController().signal,
    );
    assert.deepEqual(replay, { status: 'updated', duplicate: true });
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, action: 'ai.customer_updated', targetId: customerId },
      }),
      1,
    );

    await assert.rejects(
      updater.update(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 11n,
          idempotencyKey,
          executionMode: 'live',
          patch: { language: 'en' },
        },
        new AbortController().signal,
      ),
      /Idempotency conflict/,
    );

    await assert.rejects(
      updater.update(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 10n,
          idempotencyKey: `${turnId}:stale`,
          executionMode: 'live',
          patch: { language: 'en' },
        },
        new AbortController().signal,
      ),
      /stale/,
    );
    const afterStale = await admin.customer.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: customerId } },
    });
    assert.equal(afterStale.language, 'pt');

    await assert.rejects(
      updater.update(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 11n,
          idempotencyKey: `${turnId}:sandbox`,
          executionMode: 'sandbox',
          patch: { email: null },
        },
        new AbortController().signal,
      ),
      /live-only/,
    );

    const [requestCount] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM ai_customer_update_requests WHERE tenant_id=${tenantId}::uuid`;
    assert.equal(requestCount?.count, 1n);
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
