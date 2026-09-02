import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantService } from '../tenancy/tenant.service';
import { Actor } from '../identity/auth.service';
import { MessagePageDto, MockInboundDto } from './dto';

@Injectable()
export class MessagingService {
  constructor(private readonly tenants: TenantService) {}

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
        const message = await tx.message.findUniqueOrThrow({
          where: { externalEventId: previous.id },
        });
        return { conflict: false as const, duplicate: true, message };
      }
      const now = new Date();
      const conversation = await tx.conversation.upsert({
        where: {
          tenantId_channelConnectionId_customerId: {
            tenantId,
            channelConnectionId: channel.id,
            customerId: customer.id,
          },
        },
        create: {
          tenantId,
          customerId: customer.id,
          channelConnectionId: channel.id,
          language: customer.language,
          lastMessageAt: now,
        },
        update: { lastMessageAt: now },
      });
      const event = await tx.externalEvent.create({
        data: {
          tenantId,
          provider: 'mock',
          externalEventId,
          eventType: 'message.received',
          payloadHash,
          processedAt: now,
        },
      });
      const message = await tx.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          externalEventId: event.id,
          contentText: input.text,
        },
      });
      await this.tenants.audit(tx, actor, tenantId, 'message.mock_received', message.id);
      return { conflict: false as const, duplicate: false, message };
    });
    // Throw after commit so conflict evidence is retained, without recording message content.
    if (result.conflict) throw new ConflictException();
    return { duplicate: result.duplicate, message: result.message };
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
