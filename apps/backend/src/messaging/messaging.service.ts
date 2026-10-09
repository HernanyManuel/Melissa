import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { TenantService } from '../tenancy/tenant.service';
import { Actor } from '../identity/auth.service';
import {
  ConversationQuery,
  CreateInternalNoteDto,
  ManualReplyDto,
  MessagePageDto,
  MockInboundDto,
} from './dto';
import { CONFIG, Configuration } from '../config';
import { enqueueInbound } from './enqueue-inbound';
import { checkedReceiptState } from './receipt-state';
import { ProcessingQuery, ProcessingPageDto } from './processing.dto';
import { appendInboxEvent } from './inbox-event-store';

const PREPARED_REPLY_TTL_MS = 24 * 60 * 60 * 1000;

interface ConversationControlRow {
  id: string;
  mode: string;
  status: string;
  assignedStaffId: string | null;
  closedAt: Date | null;
  modeEpoch: bigint;
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
      const pageRows = rows.slice(0, 50);
      // Count durable inbound events, not outbound messages or SSE housekeeping.
      // Read cursors are scoped to this actor, and only these 50 visible IDs
      // are included in the query.
      const unread = pageRows.length
        ? await tx.$queryRaw<
            Array<{ conversationId: string; unreadCount: number; unreadUpTo: string }>
          >`
            SELECT e.conversation_id::text AS "conversationId",
                   COUNT(*) FILTER (
                     WHERE e.sequence > COALESCE(r.last_read_sequence, 0)
                   )::int AS "unreadCount",
                   MAX(e.sequence)::text AS "unreadUpTo"
            FROM inbox_events e
            LEFT JOIN inbox_read_cursors r
              ON r.tenant_id=e.tenant_id
              AND r.conversation_id=e.conversation_id
              AND r.actor_id=${actor.userId}::uuid
            WHERE e.tenant_id=${tenantId}::uuid
              AND e.event_type='message.received'
              AND e.conversation_id IN (
                ${Prisma.join(pageRows.map((row) => Prisma.sql`${row.id}::uuid`))}
              )
            GROUP BY e.conversation_id
          `
        : [];
      const byConversation = new Map(unread.map((row) => [row.conversationId, row]));
      return {
        // Internal fencing counters are BigInt and must not leak through the public JSON API.
        items: pageRows.map(({ modeEpoch, stateVersion, ...row }) => {
          void modeEpoch;
          void stateVersion;
          const count = byConversation.get(row.id);
          return {
            ...row,
            unreadCount: count?.unreadCount ?? 0,
            unreadUpTo: count?.unreadUpTo ?? null,
          };
        }),
        next: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }

  // Internal notes are not customer messages and are never dispatched to AI
  // or WhatsApp. A stable actor-owned key prevents double-create on retries.
  async createInternalNote(
    actor: Actor,
    tenantId: string,
    conversationId: string,
    input: CreateInternalNoteDto,
  ) {
    if (!input.text.trim()) throw new BadRequestException();
    const result = await this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { tenantId_id: { tenantId, id: conversationId } },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException();

      const previous = await tx.conversationInternalNote.findUnique({
        where: {
          tenantId_actorId_requestId: {
            tenantId,
            actorId: actor.userId,
            requestId: input.requestId,
          },
        },
      });
      if (previous) {
        if (previous.conversationId !== conversationId || previous.contentText !== input.text)
          return { conflict: true as const };
        return { conflict: false as const, note: previous, duplicate: true };
      }

      const note = await tx.conversationInternalNote.create({
        data: {
          tenantId,
          id: randomUUID(),
          conversationId,
          actorId: actor.userId,
          requestId: input.requestId,
          contentText: input.text,
        },
      });
      await this.tenants.audit(tx, actor, tenantId, 'conversation.internal_note_created', note.id);
      return { conflict: false as const, note, duplicate: false };
    });
    if (result.conflict) throw new ConflictException();
    return {
      item: {
        id: result.note.id,
        text: result.note.contentText,
        actorId: result.note.actorId,
        createdAt: result.note.createdAt,
      },
      duplicate: result.duplicate,
    };
  }

  internalNotes(actor: Actor, tenantId: string, conversationId: string, page: MessagePageDto) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { tenantId_id: { tenantId, id: conversationId } },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException();
      if (
        page.after &&
        !(await tx.conversationInternalNote.findFirst({
          where: { tenantId, conversationId, id: page.after },
          select: { id: true },
        }))
      )
        throw new NotFoundException();

      const rows = await tx.conversationInternalNote.findMany({
        where: { tenantId, conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 51,
        ...(page.after ? { cursor: { tenantId_id: { tenantId, id: page.after } }, skip: 1 } : {}),
        select: { id: true, contentText: true, actorId: true, createdAt: true },
      });
      return {
        items: rows.slice(0, 50).map((row) => ({
          id: row.id,
          text: row.contentText,
          actorId: row.actorId,
          createdAt: row.createdAt,
        })),
        next: rows.length > 50 ? rows[49]!.id : null,
      };
    });
  }

  listConversationTags(actor: Actor, tenantId: string, conversationId: string) {
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      const exists = await tx.conversation.findUnique({
        where: { tenantId_id: { tenantId, id: conversationId } },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException();
      const [available, applied] = await Promise.all([
        tx.conversationTag.findMany({
          where: { tenantId },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
          take: 100,
        }),
        tx.conversationTagLink.findMany({
          where: { tenantId, conversationId },
          select: { tagId: true },
        }),
      ]);
      return { available, applied: applied.map((row) => row.tagId) };
    });
  }

  createConversationTag(actor: Actor, tenantId: string, name: string) {
    const normalized = name.trim();
    if (normalized.length < 1 || normalized.length > 40) throw new BadRequestException();
    return this.tenants.scoped(actor, tenantId, 'conversations:takeover', async (tx) => {
      const existing = await tx.conversationTag.findUnique({
        where: { tenantId_name: { tenantId, name: normalized } },
      });
      if (existing) return { item: existing, duplicate: true };
      const item = await tx.conversationTag.create({
        data: { tenantId, id: randomUUID(), name: normalized },
      });
      await this.tenants.audit(tx, actor, tenantId, 'conversation.tag_created', item.id);
      return { item, duplicate: false };
    });
  }

  setConversationTag(
    actor: Actor,
    tenantId: string,
    conversationId: string,
    tagId: string,
    attached: boolean,
  ) {
    return this.tenants.scoped(actor, tenantId, 'conversations:takeover', async (tx) => {
      const [conversation, tag] = await Promise.all([
        tx.conversation.findUnique({
          where: { tenantId_id: { tenantId, id: conversationId } },
          select: { id: true },
        }),
        tx.conversationTag.findUnique({
          where: { tenantId_id: { tenantId, id: tagId } },
          select: { id: true },
        }),
      ]);
      if (!conversation || !tag) throw new NotFoundException();
      const where = { tenantId_conversationId_tagId: { tenantId, conversationId, tagId } };
      const existing = await tx.conversationTagLink.findUnique({ where });
      if (attached && !existing) {
        await tx.conversationTagLink.create({
          data: { tenantId, conversationId, tagId, actorId: actor.userId },
        });
      } else if (!attached && existing) {
        await tx.conversationTagLink.delete({ where });
      } else {
        return { attached, duplicate: true };
      }
      await this.tenants.audit(
        tx,
        actor,
        tenantId,
        attached ? 'conversation.tag_attached' : 'conversation.tag_detached',
        conversationId,
      );
      return { attached, duplicate: false };
    });
  }

  async markConversationRead(actor: Actor, tenantId: string, conversationId: string, upTo: string) {
    if (!/^[1-9]\d{0,18}$/.test(upTo) || BigInt(upTo) > 9_223_372_036_854_775_807n)
      throw new BadRequestException();
    const sequence = BigInt(upTo);
    return this.tenants.scoped(actor, tenantId, 'messages:read', async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { tenantId_id: { tenantId, id: conversationId } },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException();
      // Never let a guessed future sequence suppress later incoming messages.
      const [event] = await tx.$queryRaw<Array<{ sequence: bigint }>>`
        SELECT sequence
        FROM inbox_events
        WHERE tenant_id=${tenantId}::uuid AND conversation_id=${conversationId}::uuid
          AND sequence=${sequence} AND event_type='message.received'
      `;
      if (!event) throw new ConflictException();
      const key = {
        tenantId_actorId_conversationId: {
          tenantId,
          actorId: actor.userId,
          conversationId,
        },
      };
      const old = await tx.inboxReadCursor.findUnique({
        where: key,
        select: { lastReadSequence: true },
      });
      if (old && old.lastReadSequence >= sequence) {
        return { unreadUpTo: old.lastReadSequence.toString(), duplicate: true };
      }
      await tx.inboxReadCursor.upsert({
        where: key,
        create: {
          tenantId,
          actorId: actor.userId,
          conversationId,
          lastReadSequence: sequence,
        },
        update: { lastReadSequence: sequence, updatedAt: new Date() },
      });
      await appendInboxEvent(tx, {
        tenantId,
        conversationId,
        eventType: 'conversation.read',
        actorId: actor.userId,
      });
      return { unreadUpTo: upTo, duplicate: false };
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
             closed_at AS "closedAt",
             mode_epoch AS "modeEpoch"
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

  private validateManualReply(input: ManualReplyDto): void {
    if (
      !input ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      Array.from(input.text).length > 4096 ||
      /[\u0000\p{Surrogate}]/u.test(input.text)
    )
      throw new BadRequestException();
  }

  private async eligibleHumanReply(
    tx: Prisma.TransactionClient,
    actor: Actor,
    tenantId: string,
    conversationId: string,
    role: string,
  ): Promise<ConversationControlRow> {
    const current = await this.lockConversation(tx, tenantId, conversationId);
    if (
      current.status === 'closed' ||
      current.status === 'archived' ||
      current.mode !== 'HUMAN_ACTIVE' ||
      !current.assignedStaffId
    )
      throw new ConflictException();

    if (role === 'staff') {
      const assigned = await tx.staff.findFirst({
        where: {
          tenantId,
          id: current.assignedStaffId,
          active: true,
          userId: actor.userId,
        },
        select: { id: true },
      });
      if (!assigned) throw new ForbiddenException();
    }

    const target = await tx.conversation.findUnique({
      where: { tenantId_id: { tenantId, id: conversationId } },
      select: {
        customer: { select: { deletedAt: true } },
        channelConnection: {
          select: {
            channelType: true,
            mode: true,
            status: true,
            externalPhoneId: true,
            credentialsReference: true,
          },
        },
      },
    });
    if (
      !target ||
      target.customer.deletedAt ||
      target.channelConnection.channelType !== 'whatsapp' ||
      target.channelConnection.mode !== 'live' ||
      target.channelConnection.status !== 'active' ||
      !target.channelConnection.externalPhoneId.trim() ||
      !target.channelConnection.credentialsReference?.trim()
    )
      throw new NotFoundException();
    return current;
  }

  private preparationState(intent: { createdAt: Date; abandonedAt: Date | null }) {
    if (intent.abandonedAt) return 'abandoned' as const;
    if (intent.createdAt.getTime() <= Date.now() - PREPARED_REPLY_TTL_MS) return 'expired' as const;
    return 'prepared' as const;
  }

  private async findManualIntent(
    tx: Prisma.TransactionClient,
    actor: Actor,
    tenantId: string,
    requestId: string,
  ) {
    // Keep this parent locked through confirm, abandon, and retention. Without
    // FOR UPDATE a concurrent scrub could remove text before a dispatch insert.
    await tx.$queryRaw`
      SELECT id FROM human_outbound_intents
      WHERE tenant_id=${tenantId}::uuid
        AND actor_id=${actor.userId}::uuid
        AND request_id=${requestId}::uuid
      FOR UPDATE
    `;
    return tx.humanOutboundIntent.findUnique({
      where: {
        tenantId_actorId_requestId: { tenantId, actorId: actor.userId, requestId },
      },
    });
  }

  /// A durable, non-dispatchable preflight record. No worker can send it:
  /// the dispatcher only claims rows from human_outbound_dispatch.
  async prepareReply(
    actor: Actor,
    tenantId: string,
    conversationId: string,
    input: ManualReplyDto,
  ) {
    this.validateManualReply(input);
    const result = await this.tenants.scoped(
      actor,
      tenantId,
      'conversations:reply',
      async (tx, role) => {
        const previous = await this.findManualIntent(tx, actor, tenantId, input.requestId);
        if (previous) {
          if (previous.conversationId !== conversationId || previous.contentText !== input.text)
            return { conflict: true as const };
          const dispatch = await tx.humanOutboundDispatch.findUnique({
            where: { id: previous.id },
            select: { state: true },
          });
          return {
            conflict: false as const,
            intentId: previous.id,
            duplicate: true,
            state: dispatch?.state ?? this.preparationState(previous),
          };
        }

        const current = await this.eligibleHumanReply(tx, actor, tenantId, conversationId, role);
        const intent = await tx.humanOutboundIntent.create({
          data: {
            tenantId,
            id: randomUUID(),
            actorId: actor.userId,
            requestId: input.requestId,
            conversationId,
            modeEpoch: current.modeEpoch,
            contentText: input.text,
          },
        });
        await this.tenants.audit(
          tx,
          actor,
          tenantId,
          'conversation.manual_reply_prepared',
          intent.id,
        );
        return {
          conflict: false as const,
          intentId: intent.id,
          duplicate: false,
          state: 'prepared' as const,
        };
      },
    );
    if (result.conflict) throw new ConflictException();
    return { intentId: result.intentId, duplicate: result.duplicate, state: result.state };
  }

  /// Confirmation atomically makes an existing prepared record dispatchable.
  /// Legacy direct POST clients may still create and dispatch in one transaction.
  async reply(actor: Actor, tenantId: string, conversationId: string, input: ManualReplyDto) {
    this.validateManualReply(input);
    const result = await this.tenants.scoped(
      actor,
      tenantId,
      'conversations:reply',
      async (tx, role) => {
        const previous = await this.findManualIntent(tx, actor, tenantId, input.requestId);
        if (previous) {
          if (previous.conversationId !== conversationId || previous.contentText !== input.text) {
            await this.tenants.audit(
              tx,
              actor,
              tenantId,
              'conversation.manual_reply_conflict',
              previous.id,
            );
            return { conflict: true as const };
          }
          const dispatch = await tx.humanOutboundDispatch.findUnique({
            where: { id: previous.id },
            select: { state: true },
          });
          if (dispatch) {
            return {
              conflict: false as const,
              intentId: previous.id,
              duplicate: true,
              state: dispatch.state,
            };
          }

          // A prepared-only intent cannot be confirmed after abandonment/expiry.
          // Dispatch receipts are deliberately handled above (idempotent replay).
          if (this.preparationState(previous) !== 'prepared') throw new ConflictException();
          const current = await this.eligibleHumanReply(tx, actor, tenantId, conversationId, role);
          // An older prepared message can never be promoted after takeover,
          // reassignment or AI reactivation, even if the mode is HUMAN_ACTIVE again.
          if (current.modeEpoch !== previous.modeEpoch) throw new ConflictException();
          await tx.humanOutboundDispatch.create({ data: { tenantId, id: previous.id } });
          await this.tenants.audit(
            tx,
            actor,
            tenantId,
            'conversation.manual_reply_queued',
            previous.id,
          );
          return {
            conflict: false as const,
            intentId: previous.id,
            duplicate: true,
            state: 'pending' as const,
          };
        }

        const current = await this.eligibleHumanReply(tx, actor, tenantId, conversationId, role);
        const intentId = randomUUID();
        await tx.humanOutboundIntent.create({
          data: {
            tenantId,
            id: intentId,
            actorId: actor.userId,
            requestId: input.requestId,
            conversationId,
            modeEpoch: current.modeEpoch,
            contentText: input.text,
          },
        });
        await tx.humanOutboundDispatch.create({ data: { tenantId, id: intentId } });
        await this.tenants.audit(tx, actor, tenantId, 'conversation.manual_reply_queued', intentId);
        return {
          conflict: false as const,
          intentId,
          duplicate: false,
          state: 'pending' as const,
        };
      },
    );
    if (result.conflict) throw new ConflictException();
    return { intentId: result.intentId, duplicate: result.duplicate, state: result.state };
  }

  async abandonPreparedReply(
    actor: Actor,
    tenantId: string,
    conversationId: string,
    requestId: string,
  ) {
    return this.tenants.scoped(actor, tenantId, 'conversations:reply', async (tx) => {
      const intent = await this.findManualIntent(tx, actor, tenantId, requestId);
      if (!intent || intent.conversationId !== conversationId) throw new NotFoundException();

      const dispatch = await tx.humanOutboundDispatch.findUnique({
        where: { id: intent.id },
        select: { id: true },
      });
      // Never cancel queued or in-flight sends (even after provider failure).
      if (dispatch) throw new ConflictException();
      if (intent.abandonedAt)
        return { intentId: intent.id, state: 'abandoned' as const, duplicate: true };

      const result = await tx.humanOutboundIntent.updateMany({
        where: { tenantId, id: intent.id, actorId: actor.userId, abandonedAt: null },
        data: {
          abandonedAt: new Date(),
          contentText: '[redacted]',
          redactedAt: new Date(),
        },
      });
      if (result.count !== 1) throw new ConflictException();
      await this.tenants.audit(
        tx,
        actor,
        tenantId,
        'conversation.manual_reply_abandoned',
        intent.id,
      );
      return { intentId: intent.id, state: 'abandoned' as const, duplicate: false };
    });
  }

  latestManualReply(actor: Actor, tenantId: string, conversationId: string) {
    return this.tenants.scoped(actor, tenantId, 'conversations:reply', async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { tenantId_id: { tenantId, id: conversationId } },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException();

      // An operator can only recover their own original request and payload.
      // No search across actors, and no provider receipt/delivery inference.
      const intent = await tx.humanOutboundIntent.findFirst({
        where: { tenantId, conversationId, actorId: actor.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          requestId: true,
          contentText: true,
          createdAt: true,
          abandonedAt: true,
          redactedAt: true,
        },
      });
      if (!intent) return { item: null };
      const dispatch = await tx.humanOutboundDispatch.findUnique({
        where: { id: intent.id },
        select: { state: true },
      });
      // The missing dispatch is an intentional, recoverable prepare phase.
      return {
        item: {
          intentId: intent.id,
          requestId: intent.requestId,
          text: intent.redactedAt ? null : intent.contentText,
          state: dispatch?.state ?? this.preparationState(intent),
          createdAt: intent.createdAt,
        },
      };
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
