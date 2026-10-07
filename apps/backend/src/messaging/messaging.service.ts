import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TenantService } from '../tenancy/tenant.service';
import { Actor } from '../identity/auth.service';
import { MessagePageDto, MockInboundDto, ConversationQuery } from './dto';
import { CONFIG, Configuration } from '../config';
import { enqueueInbound } from './enqueue-inbound';
import { checkedReceiptState } from './receipt-state';
import { ProcessingQuery, ProcessingPageDto } from './processing.dto';
import { appendInboxEvent } from './inbox-event-store';

interface ConversationControlRow {
  id: string;
  mode: string;
  status: string;
  assignedStaffId: string | null;
  closedAt: Date | null;
}

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
      const event = await tx.externalEvent.create({
        data: {
          tenantId,
          provider: 'mock',
          externalEventId,
          eventType: 'message.received',
          payloadHash,
        },
      });
      await enqueueInbound(
        tx,
        {
          tenantId,
          channelId,
          customerId: customer.id,
          eventId: event.id,
          text: input.text,
          origin: 'mock',
          actorId: actor.userId,
        },
        this.config.MESSAGE_DEBOUNCE_MS,
      );
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
      if (
        !event ||
        event.eventType !== 'message.received' ||
        !['mock', 'whatsapp'].includes(event.provider)
      )
        throw new NotFoundException();
      const route = await tx.inboundDispatch.findFirst({ where: { id, tenantId } });
      const message = await tx.message.findUnique({ where: { externalEventId: id } });
      return {
        eventId: id,
        state: checkedReceiptState(route?.state, message !== null, event.processedAt),
        message,
      };
    });
  }

  processing(actor: Actor, tenantId: string, query: ProcessingQuery): Promise<ProcessingPageDto> {
    return this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      // Dispatch has global worker visibility: explicit tenant predicate is mandatory here.
      const rows = await tx.inboundDispatch.findMany({
        where: {
          tenantId,
          state: query.state,
          ...(query.after ? { id: { gt: query.after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
        select: { id: true, state: true, attempts: true, nextAttemptAt: true },
      });
      return {
        items: rows.slice(0, 50).map((row) => ({
          ...row,
          nextAttemptAt: row.state === 'pending' ? row.nextAttemptAt : null,
        })),
        next: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }

  conversations(actor: Actor, tenantId: string, page: ConversationQuery) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      if (
        page.after &&
        !(await tx.conversation.findUnique({
          where: { tenantId_id: { tenantId, id: page.after } },
        }))
      )
        throw new NotFoundException();
      // Escape LIKE metacharacters: user input is a literal name fragment.
      const search = page.q?.replace(/[\\%_]/g, '\\$&');
      const rows = await tx.conversation.findMany({
        where: {
          tenantId,
          ...(search
            ? {
                OR: [
                  { customer: { displayName: { contains: search, mode: 'insensitive' as const } } },
                  {
                    channelConnection: {
                      displayName: { contains: search, mode: 'insensitive' as const },
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
        ...(page.after ? { cursor: { tenantId_id: { tenantId, id: page.after } }, skip: 1 } : {}),
        include: {
          customer: { select: { displayName: true } },
          channelConnection: { select: { displayName: true, mode: true } },
        },
      });
      return {
        // Internal fencing counters are BigInt and must not leak through the public JSON API.
        items: rows.slice(0, 50).map(({ modeEpoch, stateVersion, ...row }) => {
          void modeEpoch;
          void stateVersion;
          return row;
        }),
        next: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }

  takeover(actor: Actor, tenantId: string, conversationId: string, staffId: string) {
    return this.tenants.scoped(actor, tenantId, 'conversations:takeover', async (tx, role) => {
      const staff = await tx.staff.findFirst({
        where: { tenantId, id: staffId, active: true },
        select: { id: true, userId: true },
      });
      if (!staff) throw new NotFoundException();
      if (role === 'staff' && staff.userId !== actor.userId) throw new ForbiddenException();

      const current = await this.lockConversation(tx, tenantId, conversationId);
      if (current.status === 'archived' || current.status === 'closed' || current.mode === 'CLOSED')
        throw new ConflictException();
      if (current.mode === 'HUMAN_ACTIVE') {
        if (current.assignedStaffId !== staff.id) throw new ConflictException();
        return this.conversationControl(tx, tenantId, conversationId);
      }
      if (!['AI_ACTIVE', 'WAITING_HUMAN'].includes(current.mode)) throw new ConflictException();
      if (current.mode === 'AI_ACTIVE') {
        await tx.conversation.update({
          where: { tenantId_id: { tenantId, id: conversationId } },
          data: { mode: 'WAITING_HUMAN' },
          select: { id: true },
        });
      }

      const conversation = await tx.conversation.update({
        where: { tenantId_id: { tenantId, id: conversationId } },
        data: { mode: 'HUMAN_ACTIVE', assignedStaffId: staff.id },
        select: {
          id: true,
          status: true,
          mode: true,
          assignedStaffId: true,
          closedAt: true,
        },
      });
      await this.tenants.audit(tx, actor, tenantId, 'conversation.takeover', conversationId);
      await appendInboxEvent(tx, {
        tenantId,
        conversationId,
        eventType: 'conversation.takeover',
        actorId: actor.userId,
      });
      return conversation;
    });
  }

  reactivateAI(actor: Actor, tenantId: string, conversationId: string) {
    return this.tenants.scoped(actor, tenantId, 'conversations:takeover', async (tx) => {
      const current = await this.lockConversation(tx, tenantId, conversationId);
      if (current.status === 'archived' || current.status === 'closed' || current.mode === 'CLOSED')
        throw new ConflictException();
      if (current.mode === 'AI_ACTIVE' && current.assignedStaffId === null)
        return this.conversationControl(tx, tenantId, conversationId);
      if (current.mode !== 'HUMAN_ACTIVE') throw new ConflictException();

      const conversation = await tx.conversation.update({
        where: { tenantId_id: { tenantId, id: conversationId } },
        data: { mode: 'AI_ACTIVE', assignedStaffId: null },
        select: {
          id: true,
          status: true,
          mode: true,
          assignedStaffId: true,
          closedAt: true,
        },
      });
      await this.tenants.audit(tx, actor, tenantId, 'conversation.ai_reactivated', conversationId);
      await appendInboxEvent(tx, {
        tenantId,
        conversationId,
        eventType: 'conversation.ai_reactivated',
        actorId: actor.userId,
      });
      return conversation;
    });
  }

  closeConversation(actor: Actor, tenantId: string, conversationId: string) {
    return this.tenants.scoped(actor, tenantId, 'conversations:takeover', async (tx) => {
      const current = await this.lockConversation(tx, tenantId, conversationId);
      if (current.status === 'archived') throw new ConflictException();
      if (current.status === 'closed' && current.mode === 'CLOSED')
        return this.conversationControl(tx, tenantId, conversationId);

      const conversation = await tx.conversation.update({
        where: { tenantId_id: { tenantId, id: conversationId } },
        data: {
          status: 'closed',
          mode: 'CLOSED',
          assignedStaffId: null,
          closedAt: current.closedAt ?? new Date(),
        },
        select: {
          id: true,
          status: true,
          mode: true,
          assignedStaffId: true,
          closedAt: true,
        },
      });
      await this.tenants.audit(tx, actor, tenantId, 'conversation.closed', conversationId);
      await appendInboxEvent(tx, {
        tenantId,
        conversationId,
        eventType: 'conversation.closed',
        actorId: actor.userId,
      });
      return conversation;
    });
  }

  private async lockConversation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationControlRow> {
    const [row] = await tx.$queryRaw<ConversationControlRow[]>`
      SELECT id::text, mode, status,
             assigned_staff_id::text AS "assignedStaffId",
             closed_at AS "closedAt"
      FROM conversations
      WHERE tenant_id=${tenantId}::uuid AND id=${conversationId}::uuid
      FOR UPDATE
    `;
    if (!row) throw new NotFoundException();
    return row;
  }

  private conversationControl(
    tx: Prisma.TransactionClient,
    tenantId: string,
    conversationId: string,
  ) {
    return tx.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: conversationId } },
      select: {
        id: true,
        status: true,
        mode: true,
        assignedStaffId: true,
        closedAt: true,
      },
    });
  }

  inboxEvents(actor: Actor, tenantId: string, after: bigint) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          sequence: string;
          eventType: string;
          conversationId: string;
          messageId: string | null;
          createdAt: Date;
        }>
      >`
        SELECT sequence::text AS sequence,
               event_type AS "eventType",
               conversation_id::text AS "conversationId",
               message_id::text AS "messageId",
               created_at AS "createdAt"
        FROM inbox_events
        WHERE tenant_id=${tenantId}::uuid AND sequence > ${after}
        ORDER BY sequence ASC
        LIMIT 100
      `;
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }));
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
