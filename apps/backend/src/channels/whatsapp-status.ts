import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { InboundStatusEvent } from './inbound-provider';

// Called inside the verified route's transaction, with tenant lock held.
// Immutable journal only: outbound correlation/reconciliation is a separate consumer.
export async function persistWhatsAppStatus(
  tx: Prisma.TransactionClient,
  route: { tenantId: string; channelId: string },
  event: InboundStatusEvent,
  occurredAt: Date,
) {
  const { tenantId, channelId } = route;
  const externalEventId = createHash('sha256')
    .update(JSON.stringify([channelId, event.messageId, event.status, event.timestamp]))
    .digest('hex');
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify([
        channelId,
        event.messageId,
        event.status,
        event.timestamp,
        event.recipientId,
      ]),
    )
    .digest('hex');
  // Separate namespace prevents collisions with inbound message IDs.
  const previous = await tx.externalEvent.findUnique({
    where: {
      provider_externalEventId: { provider: 'whatsapp-status', externalEventId },
    },
  });
  if (previous) {
    if (previous.payloadHash !== payloadHash) {
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'whatsapp',
          action: 'message.status_payload_conflict',
          targetId: previous.id,
        },
      });
      return { conflict: true as const };
    }
    return { conflict: false as const, eventId: previous.id, duplicate: true };
  }
  const stored = await tx.externalEvent.create({
    data: {
      tenantId,
      provider: 'whatsapp-status',
      externalEventId,
      eventType: 'message.status',
      payloadHash,
      processedAt: new Date(),
    },
  });
  await tx.whatsAppStatusEvent.create({
    data: {
      tenantId,
      id: stored.id,
      channelId,
      externalMessageId: event.messageId,
      recipientId: event.recipientId,
      status: event.status,
      occurredAt,
    },
  });
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorType: 'whatsapp',
      action: 'message.whatsapp_status_recorded',
      targetId: stored.id,
    },
  });
  return { conflict: false as const, eventId: stored.id, duplicate: false };
}
