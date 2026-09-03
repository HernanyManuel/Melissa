import { Prisma } from '@prisma/client';
import { batchDeadline } from './batching';

type Origin =
  | { origin: 'mock'; actorId: string; integrationKey?: never }
  | { origin: 'whatsapp'; actorId: null; integrationKey: string };

// Caller must already hold the tenant row lock and validate channel/customer/authority.
export async function enqueueInbound(
  tx: Prisma.TransactionClient,
  input: Origin & {
    tenantId: string;
    channelId: string;
    customerId: string;
    eventId: string;
    text: string;
  },
  debounceMs: number,
) {
  const { tenantId, channelId, customerId } = input;
  const now = new Date();
  let batch = await tx.inboundBatch.findFirst({
    where: {
      tenantId,
      channelId,
      customerId,
      sealedAt: null,
      dueAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (batch && (await tx.inboundOutbox.count({ where: { tenantId, batchId: batch.id } })) >= 50)
    batch = null;
  batch = batch
    ? await tx.inboundBatch.update({
        where: { tenantId_id: { tenantId, id: batch.id } },
        data: { dueAt: batchDeadline(batch.createdAt, now, debounceMs) },
      })
    : await tx.inboundBatch.create({
        data: {
          tenantId,
          channelId,
          customerId,
          createdAt: now,
          dueAt: batchDeadline(now, now, debounceMs),
        },
      });
  await tx.inboundOutbox.create({
    data: {
      tenantId,
      channelId,
      customerId,
      id: input.eventId,
      actorId: input.actorId,
      origin: input.origin,
      integrationKey: input.integrationKey,
      contentText: input.text,
      batchId: batch.id,
    },
  });
  await tx.inboundDispatch.create({
    data: {
      id: input.eventId,
      tenantId,
      nextAttemptAt: batch.dueAt,
    },
  });
  const events = await tx.inboundOutbox.findMany({
    where: { tenantId, batchId: batch.id },
    select: { id: true },
  });
  await tx.inboundDispatch.updateMany({
    where: {
      tenantId,
      state: 'pending',
      attempts: 0,
      id: { in: events.map((item) => item.id) },
    },
    data: { nextAttemptAt: batch.dueAt },
  });
}
