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
  const statusRank = { sent: 10, delivered: 20, read: 30, failed: 40 }[event.status];
  const dispatch = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM ai_outbound_dispatch
    WHERE tenant_id=${tenantId}::uuid
      AND provider_message_id=${event.messageId}
      AND state='accepted'
    LIMIT 1`;
  if (dispatch[0]) {
    await tx.$executeRaw`
      INSERT INTO ai_outbound_delivery_receipts (
        tenant_id, dispatch_id, provider_message_id, status, status_rank,
        provider_timestamp
      ) VALUES (
        ${tenantId}::uuid, ${dispatch[0].id}::uuid, ${event.messageId},
        ${event.status}, ${statusRank}, ${occurredAt}
      )
      ON CONFLICT (tenant_id, provider_message_id) DO UPDATE
      SET status=EXCLUDED.status,
          status_rank=EXCLUDED.status_rank,
          provider_timestamp=EXCLUDED.provider_timestamp,
          updated_at=CURRENT_TIMESTAMP
      WHERE ai_outbound_delivery_receipts.status_rank < EXCLUDED.status_rank`;
  }
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
