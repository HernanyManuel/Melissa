import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { queueConnection } from '../src/queue-connection';
import { OutboundMockProcessor } from '../src/messaging/outbound-mock-processor';
import { OutboundDispatchProcessor } from '../src/messaging/outbound-dispatch-processor';

export async function testOutboundQueue(
  admin: PrismaClient,
  tenantId: string,
  otherTenant: string,
  conversationId: string,
  actorId: string,
) {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const queue = new Queue('outgoing-mock-messages', {
    connection: queueConnection(process.env.REDIS_URL!),
  });
  // Dedicated disposable CI Redis only. Pause automatic consumption during fault injection.
  await queue.pause();
  const fresh = async () => {
    const intent = await admin.outboundIntent.create({
      data: {
        tenantId,
        actorId,
        conversationId,
        requestId: randomUUID(),
        contentText: 'Queue fixture',
      },
    });
    await admin.outboundDispatch.create({ data: { tenantId, id: intent.id } });
    return intent.id;
  };
  try {
    const id = await fresh();
    const broken = new OutboundDispatchProcessor(
      db,
      new OutboundMockProcessor(db, () => {
        throw new Error('Synthetic failure');
      }),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await admin.outboundDispatch.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
      await assert.rejects(broken.process(id, attempt));
      const row = await admin.outboundDispatch.findUniqueOrThrow({ where: { id } });
      assert.equal(row.attempts, attempt + 1);
      assert.equal(row.state, attempt === 4 ? 'failed' : 'pending');
      await broken.process(id, attempt); // stale delivery does not spend another attempt
      assert.equal(
        (await admin.outboundDispatch.findUniqueOrThrow({ where: { id } })).attempts,
        attempt + 1,
      );
    }
    assert.equal(await admin.outboundMockResult.count({ where: { id } }), 0);
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, targetId: id, action: 'outbound.dispatch_failed' },
      }),
      1,
    );
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${otherTenant},true)`;
        await tx.outboundDispatch.update({
          where: { id },
          data: { state: 'pending', attempts: 0 },
        });
      }),
    );
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
        await tx.outboundDispatch.update({ where: { id }, data: { tenantId: otherTenant } });
      }),
    );
    const recovered = await fresh();
    await new OutboundMockProcessor(db).process(tenantId, recovered);
    // Simulated crash gap: committed result exists, dispatch is still pending.
    await new OutboundDispatchProcessor(db).process(recovered, 0);
    assert.equal(
      (await admin.outboundDispatch.findUniqueOrThrow({ where: { id: recovered } })).state,
      'mock_accepted',
    );
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, targetId: recovered, action: 'outbound.mock_accepted' },
      }),
      1,
    );

    const queued = await fresh();
    await queue.resume();
    const deadline = Date.now() + 15000;
    let state = 'pending';
    while (Date.now() < deadline) {
      state = (await admin.outboundDispatch.findUniqueOrThrow({ where: { id: queued } })).state;
      if (state !== 'pending') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(state, 'mock_accepted', 'separate worker must discover durable intent');
    assert.equal(await admin.outboundMockResult.count({ where: { id: queued } }), 1);
    await queue.add(
      'mock-outbound',
      { id: queued, attempt: 0 },
      { removeOnComplete: true, removeOnFail: true },
    );
    await new OutboundDispatchProcessor(db).process(queued, 0);
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId, targetId: queued, action: 'outbound.mock_accepted' },
      }),
      1,
    );
  } finally {
    await queue.resume();
    await queue.close();
    await db.$disconnect();
  }
}
