import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { MockMessagingProvider } from '../src/channels/mock-messaging-provider';
import { OutboundMockProcessor } from '../src/messaging/outbound-mock-processor';

export async function testOutboundProcessing(
  admin: PrismaClient,
  tenantId: string,
  otherTenant: string,
  conversationId: string,
  membershipId: string,
) {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const member = await admin.membership.findUniqueOrThrow({ where: { id: membershipId } });
  const conversation = await admin.conversation.findUniqueOrThrow({
    where: { tenantId_id: { tenantId, id: conversationId } },
  });
  const fresh = () =>
    admin.outboundIntent.create({
      data: {
        tenantId,
        actorId: member.userId,
        requestId: randomUUID(),
        conversationId,
        contentText: 'Simulation only',
      },
    });
  let calls = 0;
  const processor = new OutboundMockProcessor(db, () => {
    calls++;
    return new MockMessagingProvider();
  });
  try {
    const intent = await fresh();
    assert.equal(await processor.process(otherTenant, intent.id), null);
    const results = await Promise.all([
      processor.process(tenantId, intent.id),
      processor.process(tenantId, intent.id),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]?.state, 'mock_accepted');
    assert.equal(results[0]?.providerMessageId, `mock:${intent.id}`);
    assert.equal(calls, 1);
    assert.deepEqual(await new OutboundMockProcessor(db).process(tenantId, intent.id), results[0]);
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, targetId: intent.id, action: 'outbound.mock_accepted' },
      }),
      1,
    );

    await admin.membership.update({ where: { id: membershipId }, data: { active: false } });
    const revoked = await fresh();
    assert.equal((await processor.process(tenantId, revoked.id))?.state, 'rejected');
    assert.deepEqual(await processor.process(tenantId, intent.id), results[0]);
    await admin.membership.update({ where: { id: membershipId }, data: { active: true } });
    assert.equal((await processor.process(tenantId, revoked.id))?.state, 'rejected');
    assert.equal(calls, 1);

    await admin.conversation.update({
      where: { tenantId_id: { tenantId, id: conversationId } },
      data: { status: 'closed' },
    });
    assert.equal((await processor.process(tenantId, (await fresh()).id))?.state, 'rejected');
    await admin.conversation.update({
      where: { tenantId_id: { tenantId, id: conversationId } },
      data: { status: conversation.status },
    });

    const failed = await fresh();
    const failure = new Error('Synthetic mock failure');
    const broken = new OutboundMockProcessor(db, () => {
      throw failure;
    });
    await assert.rejects(broken.process(tenantId, failed.id), (error) => error === failure);
    assert.equal(await admin.outboundMockResult.count({ where: { tenantId, id: failed.id } }), 0);
    assert.equal(await admin.auditEvent.count({ where: { tenantId, targetId: failed.id } }), 0);
    assert.equal((await processor.process(tenantId, failed.id))?.state, 'mock_accepted');
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${otherTenant},true)`;
      assert.equal(await tx.outboundMockResult.count({ where: { id: intent.id } }), 0);
    });
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
        await tx.outboundMockResult.delete({ where: { tenantId_id: { tenantId, id: intent.id } } });
      }),
    );
  } finally {
    await admin.membership.update({
      where: { id: membershipId },
      data: { active: member.active, role: member.role },
    });
    await admin.conversation.update({
      where: { tenantId_id: { tenantId, id: conversationId } },
      data: { status: conversation.status },
    });
    await db.$disconnect();
  }
}
