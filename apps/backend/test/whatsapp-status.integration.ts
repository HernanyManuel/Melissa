import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { WhatsAppIngress } from '../src/channels/whatsapp-ingress';
import { PrismaAITurnLedgerRepository } from '../src/ai/ai-turn-ledger';
import { PrismaAIAutomaticOutboundStore } from '../src/ai/ai-outbound-dispatcher';

type AIDeliveryReceiptRow = {
  status: string;
  statusRank: number;
};

type CountRow = { count: bigint };

export async function testWhatsAppStatuses(
  admin: PrismaClient,
  runtime: PrismaClient,
  ingress: WhatsAppIngress,
  scope: {
    tenantId: string;
    otherTenantId: string;
    channelId: string;
    account: string;
    phone: string;
    secret: string;
  },
) {
  const externalId = `wamid.status.${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const customer = await admin.customer.findFirstOrThrow({
    where: { tenantId: scope.tenantId },
  });
  const conversationId = randomUUID();
  await admin.conversation.create({
    data: {
      id: conversationId,
      tenantId: scope.tenantId,
      customerId: customer.id,
      channelConnectionId: scope.channelId,
      mode: 'AI_ACTIVE',
      modeEpoch: 1n,
      stateVersion: 1n,
      lastMessageAt: new Date(),
    },
  });
  const deps = { db: runtime } as unknown as ConstructorParameters<
    typeof PrismaAITurnLedgerRepository
  >[0];
  const ledger = new PrismaAITurnLedgerRepository(deps);
  const turnId = randomUUID();
  assert.equal(
    await ledger.begin({
      tenantId: scope.tenantId,
      turnId,
      conversationId,
      customerId: customer.id,
      modeEpoch: 1n,
      stateVersion: 1n,
    }),
    'started',
  );
  assert.equal(
    await ledger.finish({
      tenantId: scope.tenantId,
      turnId,
      outcome: 'completed',
      rounds: 1,
      toolCalls: 0,
      failureCode: null,
      providerKey: 'mock',
      modelKey: 'mock',
      inputTokens: 1,
      outputTokens: 1,
      deliveryText: 'Status correlation',
    }),
    'finished',
  );
  const outbound = await admin.aiOutboundIntent.findFirstOrThrow({
    where: { tenantId: scope.tenantId, turnId },
  });
  const store = new PrismaAIAutomaticOutboundStore(deps);
  const claim = await store.claim(outbound.id, 0);
  assert(claim);
  await store.accept(claim, {
    providerMessageId: externalId,
    acceptedAt: new Date(),
  });
  const payload = (status: string, timestamp = String(now), recipient = '351900000099') =>
    Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: scope.account,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: scope.phone },
                  statuses: [{ id: externalId, recipient_id: recipient, timestamp, status }],
                },
              },
            ],
          },
        ],
      }),
    );
  const send = (body: Buffer) =>
    ingress.receive(
      body,
      `sha256=${createHmac('sha256', scope.secret).update(body).digest('hex')}`,
    );
  const customers = await admin.customer.count({ where: { tenantId: scope.tenantId } });
  const outbox = await admin.inboundOutbox.count({ where: { tenantId: scope.tenantId } });
  const read = payload('read');
  await assert.rejects(ingress.receive(read, 'invalid'), /signature/);
  const [one, two] = await Promise.all([send(read), send(read)]);
  assert.equal(one[0]!.eventId, two[0]!.eventId);
  assert.notEqual(one[0]!.duplicate, two[0]!.duplicate);
  // Callback order is not delivery order. Preserve the facts without regressing a message.
  await send(payload('delivered', String(now - 1)));
  await send(payload('sent', String(now - 2)));
  await send(payload('failed'));
  const where = {
    tenantId: scope.tenantId,
    channelId: scope.channelId,
    externalMessageId: externalId,
  };
  assert.equal(await admin.whatsAppStatusEvent.count({ where }), 4);
  const [aiReceipt] = await admin.$queryRaw<AIDeliveryReceiptRow[]>`
    SELECT status, status_rank AS "statusRank"
    FROM ai_outbound_delivery_receipts
    WHERE tenant_id=${scope.tenantId}::uuid
      AND provider_message_id=${externalId}`;
  assert.equal(aiReceipt?.status, 'failed');
  assert.equal(aiReceipt?.statusRank, 40);
  const receiptCount = await admin.$queryRaw<CountRow[]>`
    SELECT count(*) AS count
    FROM ai_outbound_delivery_receipts
    WHERE tenant_id=${scope.tenantId}::uuid
      AND provider_message_id=${externalId}`;
  assert.equal(Number(receiptCount[0]?.count ?? 0n), 1);
  const statuses = await admin.whatsAppStatusEvent.findMany({
    where,
    orderBy: { occurredAt: 'asc' },
  });
  assert.equal(statuses[0]!.status, 'sent');
  assert.equal(statuses[1]!.status, 'delivered');
  assert.equal(await admin.customer.count({ where: { tenantId: scope.tenantId } }), customers);
  assert.equal(await admin.inboundOutbox.count({ where: { tenantId: scope.tenantId } }), outbox);
  assert.equal(await admin.message.count({ where: { externalEventId: one[0]!.eventId } }), 0);
  assert.equal(
    await admin.auditEvent.count({
      where: {
        tenantId: scope.tenantId,
        action: 'message.whatsapp_status_recorded',
        targetId: { in: statuses.map((item) => item.id) },
      },
    }),
    4,
  );
  await assert.rejects(send(payload('read', String(now), '351900000098')), /payload conflict/);
  assert.equal(
    await admin.auditEvent.count({
      where: {
        tenantId: scope.tenantId,
        action: 'message.status_payload_conflict',
        targetId: one[0]!.eventId,
      },
    }),
    1,
  );
  await assert.rejects(send(payload('future-status')), /Unsupported/);
  assert.equal(await admin.whatsAppStatusEvent.count({ where }), 4);
  assert.equal(await runtime.whatsAppStatusEvent.count({ where }), 0);
  await runtime.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id',${scope.otherTenantId},true)`;
    assert.equal(await tx.whatsAppStatusEvent.count({ where }), 0);
  });
  await runtime.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id',${scope.tenantId},true)`;
    assert.equal(await tx.whatsAppStatusEvent.count({ where }), 4);
  });
  await assert.rejects(
    runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${scope.tenantId},true)`;
      await tx.whatsAppStatusEvent.update({
        where: {
          tenantId_id: {
            tenantId: scope.tenantId,
            id: one[0]!.eventId,
          },
        },
        data: { status: 'failed' },
      });
    }),
  );
  await assert.rejects(
    runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${scope.tenantId},true)`;
      await tx.whatsAppStatusEvent.deleteMany({ where });
    }),
  );
}
