import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaLeadCreator } from '../src/ai/create-lead-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('create_lead is fenced, durable and replay-safe', { timeout: 15000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'create lead integration requires MIGRATION_DATABASE_URL');
  const config = parseConfig(process.env);
  const deps = new Dependencies(config);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const customerId = randomUUID();
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const idempotencyKey = `${turnId}:lead_1`;
  const creator = new PrismaLeadCreator(deps);

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Lead fixture',
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
        externalPhoneId: `${Date.now()}3`,
        displayName: 'Lead channel',
        credentialsReference: 'secret://test/whatsapp',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.customer.create({
      data: {
        id: customerId,
        tenantId,
        displayName: 'Lead Customer',
        phoneE164: '+351910000098',
        email: 'lead@example.com',
        language: 'pt',
      },
    });
    await admin.conversation.create({
      data: {
        id: conversationId,
        tenantId,
        customerId,
        channelConnectionId: channelId,
        mode: 'AI_ACTIVE',
        modeEpoch: 12n,
        stateVersion: 5n,
        lastMessageAt: new Date(),
      },
    });
    await admin.$executeRaw`
      INSERT INTO ai_turns (
        tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
      ) VALUES (
        ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
        ${customerId}::uuid, 12, 5
      )`;

    const first = await creator.create(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 12n,
        idempotencyKey,
        executionMode: 'live',
        topic: 'Orçamento',
        details: 'Cliente pediu seguimento comercial amanhã.',
      },
      new AbortController().signal,
    );
    assert.deepEqual(first, { status: 'created', duplicate: false });

    const [lead] = await admin.$queryRaw<
      Array<{
        customer_id: string;
        conversation_id: string;
        topic: string;
        details: string;
        status: string;
      }>
    >`
      SELECT customer_id::text, conversation_id::text, topic, details, status
      FROM leads
      WHERE tenant_id=${tenantId}::uuid AND idempotency_key=${idempotencyKey}
    `;
    assert.equal(lead?.customer_id, customerId);
    assert.equal(lead?.conversation_id, conversationId);
    assert.equal(lead?.topic, 'Orçamento');
    assert.equal(lead?.details, 'Cliente pediu seguimento comercial amanhã.');
    assert.equal(lead?.status, 'new');
    assert.equal(
      await admin.auditEvent.count({ where: { tenantId, action: 'ai.lead_created' } }),
      1,
    );

    const replay = await creator.create(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 12n,
        idempotencyKey,
        executionMode: 'live',
        topic: 'Orçamento',
        details: 'Cliente pediu seguimento comercial amanhã.',
      },
      new AbortController().signal,
    );
    assert.deepEqual(replay, { status: 'created', duplicate: true });
    const [countAfterReplay] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM leads WHERE tenant_id=${tenantId}::uuid`;
    assert.equal(countAfterReplay?.count, 1n);
    assert.equal(
      await admin.auditEvent.count({ where: { tenantId, action: 'ai.lead_created' } }),
      1,
    );

    await assert.rejects(
      creator.create(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 12n,
          idempotencyKey,
          executionMode: 'live',
          topic: 'Outro assunto',
          details: 'Conteúdo diferente.',
        },
        new AbortController().signal,
      ),
      /Idempotency conflict/,
    );

    await assert.rejects(
      creator.create(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 11n,
          idempotencyKey: `${turnId}:stale`,
          executionMode: 'live',
          topic: 'Stale',
          details: 'Não deve persistir.',
        },
        new AbortController().signal,
      ),
      /stale/,
    );

    await assert.rejects(
      creator.create(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 12n,
          idempotencyKey: `${turnId}:sandbox`,
          executionMode: 'sandbox',
          topic: 'Sandbox',
          details: 'Não deve persistir.',
        },
        new AbortController().signal,
      ),
      /live-only/,
    );

    const [finalCount] = await admin.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM leads WHERE tenant_id=${tenantId}::uuid`;
    assert.equal(finalCount?.count, 1n);
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
