import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { WhatsAppInboundProvider } from './whatsapp-inbound';
import { WhatsAppRouting } from './whatsapp-routing';
import { enqueueInbound } from '../messaging/enqueue-inbound';
import { resolveInboundCustomer } from '../customers/inbound-customer';

// Internal composition, not an HTTP controller. Accepts signed bytes, never caller tenant IDs.
export class WhatsAppIngress {
  private readonly provider: WhatsAppInboundProvider;
  private readonly routing: WhatsAppRouting;
  constructor(
    db: PrismaClient,
    private readonly integrationKey: string,
    appSecret: string,
    verifyToken: string,
    private readonly debounceMs = 1500,
  ) {
    if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 2000)
      throw new Error('Invalid debounce');
    this.provider = new WhatsAppInboundProvider(appSecret, verifyToken);
    this.routing = new WhatsAppRouting(db, integrationKey);
  }

  async receive(raw: Buffer, signature: unknown) {
    const result = this.provider.decode(raw, signature);
    // No silent ACK for unsupported callbacks/media; reject before any writes.
    if (result.unsupported || result.events.some((event) => event.kind !== 'text'))
      throw new Error('Unsupported WhatsApp event');
    const receipts: Array<{ eventId: string; duplicate: boolean }> = [];
    for (const event of result.events) {
      if (event.kind !== 'text') throw new Error('Unsupported WhatsApp event');
      if (!/^[1-9]\d{6,14}$/.test(event.senderId)) throw new Error('Unsupported sender identity');
      const occurredAt = new Date(Number(event.timestamp) * 1000);
      if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 300000)
        throw new Error('Invalid message timestamp');
      const receipt = await this.routing.scoped(
        event.accountId,
        event.phoneId,
        async (tx, route) => {
          const { tenantId, channelId } = route;
          const externalEventId = `${channelId}:${event.messageId}`;
          const payloadHash = createHash('sha256')
            .update(JSON.stringify([event.senderId, event.timestamp, event.text]))
            .digest('hex');
          const previous = await tx.externalEvent.findUnique({
            where: {
              provider_externalEventId: { provider: 'whatsapp', externalEventId },
            },
          });
          if (previous) {
            if (previous.payloadHash !== payloadHash) {
              await tx.auditEvent.create({
                data: {
                  tenantId,
                  actorType: 'whatsapp',
                  action: 'message.external_payload_conflict',
                  targetId: previous.id,
                },
              });
              return { conflict: true as const };
            }
            return { conflict: false as const, eventId: previous.id, duplicate: true };
          }
          const customer = await resolveInboundCustomer(tx, tenantId, event.senderId);
          const stored = await tx.externalEvent.create({
            data: {
              tenantId,
              provider: 'whatsapp',
              externalEventId,
              eventType: 'message.received',
              payloadHash,
              createdAt: occurredAt,
            },
          });
          await enqueueInbound(
            tx,
            {
              tenantId,
              channelId,
              customerId: customer.id,
              eventId: stored.id,
              text: event.text,
              origin: 'whatsapp',
              actorId: null,
              integrationKey: this.integrationKey,
            },
            this.debounceMs,
          );
          await tx.auditEvent.create({
            data: {
              tenantId,
              actorType: 'whatsapp',
              action: 'message.whatsapp_accepted',
              targetId: stored.id,
            },
          });
          return { conflict: false as const, eventId: stored.id, duplicate: false };
        },
      );
      if (receipt.conflict) throw new Error('WhatsApp payload conflict');
      receipts.push({ eventId: receipt.eventId, duplicate: receipt.duplicate });
    }
    return receipts;
  }
}
