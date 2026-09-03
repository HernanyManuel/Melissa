import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantService } from '../tenancy/tenant.service';
import { Actor } from '../identity/auth.service';
import { MessagePageDto, MockInboundDto } from './dto';
import { CONFIG, Configuration } from '../config';
import { batchDeadline } from './batching';

@Injectable()
export class MessagingService {
  constructor(
    private readonly tenants: TenantService,
    @Inject(CONFIG) private readonly config: Configuration,
  ) {}

  async receiveMock(actor: Actor, tenantId: string, channelId: string, input: MockInboundDto) {
    const result = await this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      const channel = await tx.channelConnection.findFirst({
        where: { tenantId, id: channelId, mode: 'mock', status: 'active' },
      });
      if (!channel) throw new NotFoundException();
      const customer = await tx.customer.findFirst({
        where: { tenantId, id: input.customerId, deletedAt: null },
      });
      if (!customer) throw new NotFoundException();
      // Server-owned channel namespace prevents a tenant selecting another tenant's event key.
      const externalEventId = `${channel.id}:${input.eventId}`;
      const payloadHash = createHash('sha256')
        .update(JSON.stringify([customer.id, input.text]))
        .digest('hex');
      const previous = await tx.externalEvent.findUnique({
        where: { provider_externalEventId: { provider: 'mock', externalEventId } },
      });
      if (previous) {
        if (previous.payloadHash !== payloadHash) {
          await this.tenants.audit(
            tx,
            actor,
            tenantId,
            'message.duplicate_payload_conflict',
            previous.id,
          );
          return { conflict: true as const };
        }
        return { conflict: false as const, duplicate: true, eventId: previous.id };
      }
      const now = new Date();
      let batch = await tx.inboundBatch.findFirst({
        where: { tenantId, channelId, customerId: customer.id, sealedAt: null, dueAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      });
      if (batch && (await tx.inboundOutbox.count({ where: { tenantId, batchId: batch.id } })) >= 50)
        batch = null;
      if (batch) {
        batch = await tx.inboundBatch.update({
          where: { tenantId_id: { tenantId, id: batch.id } },
          data: { dueAt: batchDeadline(batch.createdAt, now, this.config.MESSAGE_DEBOUNCE_MS) },
        });
      } else {
        batch = await tx.inboundBatch.create({
          data: {
            tenantId,
            channelId,
            customerId: customer.id,
            createdAt: now,
            dueAt: batchDeadline(now, now, this.config.MESSAGE_DEBOUNCE_MS),
          },
        });
      }
      const event = await tx.externalEvent.create({
        data: {
          tenantId,
          provider: 'mock',
          externalEventId,
          eventType: 'message.received',
          payloadHash,
        },
      });
      await tx.inboundOutbox.create({
        data: {
          tenantId,
          id: event.id,
          channelId,
          customerId: customer.id,
          actorId: actor.userId,
          contentText: input.text,
          batchId: batch.id,
        },
      });
      await tx.inboundDispatch.create({
        data: { id: event.id, tenantId, nextAttemptAt: batch.dueAt },
      });
      const batchEvents = await tx.inboundOutbox.findMany({
        where: { tenantId, batchId: batch.id },
        select: { id: true },
      });
      await tx.inboundDispatch.updateMany({
        where: {
          tenantId,
          state: 'pending',
          attempts: 0,
          id: { in: batchEvents.map((item) => item.id) },
        },
        data: { nextAttemptAt: batch.dueAt },
      });
      await this.tenants.audit(tx, actor, tenantId, 'message.mock_accepted', event.id);
      return { conflict: false as const, duplicate: false, eventId: event.id };
    });
    // Throw after commit so conflict evidence is retained, without recording message content.
    if (result.conflict) throw new ConflictException();
    return { duplicate: result.duplicate, eventId: result.eventId };
  }

  receipt(actor: Actor, tenantId: string, id: string) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      const event = await tx.externalEvent.findUnique({ where: { tenantId_id: { tenantId, id } } });
      if (!event) throw new NotFoundException();
      const route = await tx.inboundDispatch.findFirst({ where: { id, tenantId } });
      const message = await tx.message.findUnique({ where: { externalEventId: id } });
      return { eventId: id, state: route?.state ?? 'processed', message };
    });
  }

  conversations(actor: Actor, tenantId: string, page: MessagePageDto) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      if (
        page.after &&
        !(await tx.conversation.findUnique({
          where: { tenantId_id: { tenantId, id: page.after } },
        }))
      )
        throw new NotFoundException();
      const rows = await tx.conversation.findMany({
        where: { tenantId },
        orderBy: { id: 'asc' },
        take: 51,
        ...(page.after ? { cursor: { tenantId_id: { tenantId, id: page.after } }, skip: 1 } : {}),
        include: {
          customer: { select: { displayName: true } },
          channelConnection: { select: { displayName: true, mode: true } },
        },
      });
      return { items: rows.slice(0, 50), next: rows.length > 50 ? rows[49]!.id : null };
    });
  }

  messages(actor: Actor, tenantId: string, conversationId: string, page: MessagePageDto) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      if (
        !(await tx.conversation.findUnique({
          where: { tenantId_id: { tenantId, id: conversationId } },
        }))
      )
        throw new NotFoundException();
      if (
        page.after &&
        !(await tx.message.findFirst({ where: { tenantId, conversationId, id: page.after } }))
      )
        throw new NotFoundException();
      const rows = await tx.message.findMany({
        where: { tenantId, conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 51,
        ...(page.after ? { cursor: { tenantId_id: { tenantId, id: page.after } }, skip: 1 } : {}),
      });
      return { items: rows.slice(0, 50), next: rows.length > 50 ? rows[49]!.id : null };
    });
  }
}
