import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { MessagingDeliveryUnknown } from '../channels/messaging-provider';
import { MessagingProviderRegistry, ProviderChannel } from '../channels/messaging-provider-registry';
import { Dependencies } from '../dependencies';
import { ConversationLock } from './conversation-lock';
import { appendInboxEvent } from './inbox-event-store';

type RejectReason = 'stale' | 'unauthorized';
type ScopedRun<T> = (tx: Prisma.TransactionClient) => Promise<T>;
type AssertOwned = () => Promise<void>;
type LeaseWork = (assertOwned: AssertOwned) => Promise<void>;

interface DispatchRow {
  id: string;
  tenantId: string;
  actorId: string;
  conversationId: string;
  modeEpoch: bigint;
  attempts: number;
  state: string;
  nextAttemptAt: Date;
  text: string;
  recipientReference: string;
  senderReference: string;
  credentialsReference: string | null;
  conversationMode: string;
  currentModeEpoch: bigint;
  conversationStatus: string;
  customerDeletedAt: Date | null;
  channelType: string;
  channelMode: string;
  channelStatus: string;
}

export interface HumanOutboundClaim {
  id: string;
  tenantId: string;
  actorId: string;
  conversationId: string;
  modeEpoch: bigint;
  attempt: number;
  recipientReference: string;
  senderReference: string;
  credentialsReference: string | null;
  text: string;
  channel: ProviderChannel;
}

export interface HumanOutboundStore {
  claim(id: string, attempt: number): Promise<HumanOutboundClaim | null>;
  isCurrent(claim: HumanOutboundClaim): Promise<boolean>;
  reject(claim: HumanOutboundClaim, reason: RejectReason): Promise<void>;
  accept(
    claim: HumanOutboundClaim,
    receipt: { providerMessageId: string; acceptedAt: Date },
  ): Promise<void>;
  recordFailure(claim: HumanOutboundClaim): Promise<void>;
  recordUnknownDelivery(claim: HumanOutboundClaim): Promise<void>;
}

export type HumanOutboundLease = (key: string, work: LeaseWork) => Promise<boolean>;

export class HumanOutboundFailed extends Error {
  constructor() {
    super('Human outbound processing failed');
    this.name = 'HumanOutboundFailed';
  }
}

export class PrismaHumanOutboundStore implements HumanOutboundStore {
  constructor(private readonly deps: Dependencies) {}

  private scoped<T>(tenantId: string, run: ScopedRun<T>): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }

  async claim(id: string, attempt: number): Promise<HumanOutboundClaim | null> {
    const [route] = await this.deps.db.$queryRaw<{ tenantId: string }[]>`
      SELECT tenant_id AS "tenantId"
      FROM human_outbound_dispatch
      WHERE id=${id}::uuid
    `;
    if (!route) return null;

    return this.scoped(route.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<DispatchRow[]>`
        SELECT d.id, d.tenant_id AS "tenantId",
          i.actor_id AS "actorId", i.conversation_id AS "conversationId",
          i.mode_epoch AS "modeEpoch", d.attempts, d.state,
          d.next_attempt_at AS "nextAttemptAt", i.content_text AS text,
          cu.phone_e164 AS "recipientReference",
          ch.external_phone_id AS "senderReference",
          ch.credentials_reference AS "credentialsReference",
          c.mode AS "conversationMode", c.mode_epoch AS "currentModeEpoch",
          c.status AS "conversationStatus", cu.deleted_at AS "customerDeletedAt",
          ch.channel_type AS "channelType", ch.mode AS "channelMode",
          ch.status AS "channelStatus"
        FROM human_outbound_dispatch d
        JOIN human_outbound_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
        JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
        JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id
        JOIN channel_connections ch
          ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_connection_id
        WHERE d.tenant_id=${route.tenantId}::uuid AND d.id=${id}::uuid
      `;
      if (!this.isDue(row, attempt)) return null;
      const claim = this.toClaim(row);
      if (!this.isAuthorized(row)) {
        await this.rejectInTransaction(tx, claim, 'unauthorized');
        return null;
      }
      return claim;
    });
  }

  isCurrent(claim: HumanOutboundClaim): Promise<boolean> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ current: boolean }[]>`
        SELECT EXISTS(
          SELECT 1
          FROM human_outbound_dispatch d
          JOIN human_outbound_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
          JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
          JOIN customers cu ON cu.tenant_id=c.tenant_id AND cu.id=c.customer_id
          JOIN channel_connections ch
            ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_connection_id
          WHERE d.tenant_id=${claim.tenantId}::uuid
            AND d.id=${claim.id}::uuid AND d.state='pending'
            AND d.attempts=${claim.attempt} AND d.next_attempt_at <= now()
            AND i.actor_id=${claim.actorId}::uuid
            AND i.conversation_id=${claim.conversationId}::uuid
            AND i.mode_epoch=${claim.modeEpoch}
            AND c.mode='HUMAN_ACTIVE' AND c.mode_epoch=i.mode_epoch
            AND c.status NOT IN ('closed','archived')
            AND cu.deleted_at IS NULL
            AND ch.channel_type='whatsapp' AND ch.mode='live' AND ch.status='active'
            AND ch.external_phone_id=${claim.senderReference}
            AND ch.credentials_reference IS NOT DISTINCT FROM ${claim.credentialsReference}
        ) AS current
      `;
      return row?.current === true;
    });
  }

  reject(claim: HumanOutboundClaim, reason: RejectReason): Promise<void> {
    return this.scoped(claim.tenantId, (tx) => this.rejectInTransaction(tx, claim, reason));
  }

  accept(
    claim: HumanOutboundClaim,
    receipt: { providerMessageId: string; acceptedAt: Date },
  ): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE human_outbound_dispatch
        SET state='accepted',
            provider_message_id=${receipt.providerMessageId},
            accepted_at=${receipt.acceptedAt}
        WHERE tenant_id=${claim.tenantId}::uuid
          AND id=${claim.id}::uuid AND state='pending'
      `;
      if (updated !== 1) return;

      const externalEventId = randomUUID();
      const payloadHash = createHash('sha256')
        .update(`${claim.id}:${receipt.providerMessageId}`)
        .digest('hex');
      await tx.externalEvent.create({
        data: {
          tenantId: claim.tenantId,
          id: externalEventId,
          provider: 'manual',
          externalEventId: claim.id,
          eventType: 'message.sent',
          payloadHash,
          processedAt: receipt.acceptedAt,
          createdAt: receipt.acceptedAt,
        },
      });
      const message = await tx.message.create({
        data: {
          tenantId: claim.tenantId,
          conversationId: claim.conversationId,
          externalEventId,
          direction: 'outbound',
          senderType: 'staff',
          contentText: claim.text,
          status: 'accepted',
          aiGenerated: false,
          createdAt: receipt.acceptedAt,
        },
      });
      await tx.conversation.updateMany({
        where: {
          tenantId: claim.tenantId,
          id: claim.conversationId,
          lastMessageAt: { lt: receipt.acceptedAt },
        },
        data: { lastMessageAt: receipt.acceptedAt },
      });
      await appendInboxEvent(tx, {
        tenantId: claim.tenantId,
        conversationId: claim.conversationId,
        eventType: 'message.sent',
        messageId: message.id,
        actorId: claim.actorId,
      });
      await this.audit(tx, claim, 'conversation.manual_reply_accepted');
    });
  }

  recordFailure(claim: HumanOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [current] = await tx.$queryRaw<{ state: string; attempts: number }[]>`
        SELECT state, attempts
        FROM human_outbound_dispatch
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
        FOR UPDATE
      `;
      if (!current || current.state !== 'pending' || current.attempts !== claim.attempt) return;
      const attempts = claim.attempt + 1;
      const terminal = attempts >= 5;
      await tx.$executeRaw`
        UPDATE human_outbound_dispatch
        SET attempts=${attempts},
            state=${terminal ? 'failed' : 'pending'},
            next_attempt_at=${new Date(Date.now() + Math.min(60_000, 1000 * 2 ** claim.attempt))}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
      `;
      if (terminal) await this.deadLetter(tx, claim, 'retry_exhausted', attempts);
      await this.audit(
        tx,
        claim,
        terminal ? 'conversation.manual_reply_failed' : 'conversation.manual_reply_retry',
      );
    });
  }

  recordUnknownDelivery(claim: HumanOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE human_outbound_dispatch
        SET attempts=${claim.attempt + 1}, state='failed'
        WHERE tenant_id=${claim.tenantId}::uuid
          AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}
      `;
      if (updated === 1) {
        await this.deadLetter(tx, claim, 'delivery_unknown', claim.attempt + 1);
        await this.audit(tx, claim, 'conversation.manual_reply_delivery_unknown');
      }
    });
  }

  private isDue(row: DispatchRow | undefined, attempt: number): row is DispatchRow {
    return (
      !!row &&
      row.state === 'pending' &&
      row.attempts === attempt &&
      row.nextAttemptAt <= new Date()
    );
  }

  private isAuthorized(row: DispatchRow): boolean {
    return (
      row.conversationMode === 'HUMAN_ACTIVE' &&
      row.currentModeEpoch === row.modeEpoch &&
      !['closed', 'archived'].includes(row.conversationStatus) &&
      row.customerDeletedAt === null &&
      row.channelType === 'whatsapp' &&
      row.channelMode === 'live' &&
      row.channelStatus === 'active' &&
      !!row.senderReference.trim() &&
      !!row.credentialsReference?.trim()
    );
  }

  private toClaim(row: DispatchRow): HumanOutboundClaim {
    return {
      id: row.id,
      tenantId: row.tenantId,
      actorId: row.actorId,
      conversationId: row.conversationId,
      modeEpoch: row.modeEpoch,
      attempt: row.attempts,
      recipientReference: row.recipientReference,
      senderReference: row.senderReference,
      credentialsReference: row.credentialsReference,
      text: row.text,
      channel: {
        mode: row.channelMode,
        channelType: row.channelType,
        status: row.channelStatus,
      },
    };
  }

  private async rejectInTransaction(
    tx: Prisma.TransactionClient,
    claim: HumanOutboundClaim,
    reason: RejectReason,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE human_outbound_dispatch
      SET state='rejected'
      WHERE tenant_id=${claim.tenantId}::uuid
        AND id=${claim.id}::uuid AND state='pending'
    `;
    if (updated === 1)
      await this.audit(tx, claim, `conversation.manual_reply_${reason}`);
  }

  private async deadLetter(
    tx: Prisma.TransactionClient,
    claim: HumanOutboundClaim,
    reason: 'retry_exhausted' | 'delivery_unknown',
    attempts: number,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO human_outbound_dead_letters
        (tenant_id, dispatch_id, reason, attempts)
      VALUES (${claim.tenantId}::uuid, ${claim.id}::uuid, ${reason}, ${attempts})
      ON CONFLICT (tenant_id, dispatch_id) DO NOTHING
    `;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    claim: HumanOutboundClaim,
    action: string,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId: claim.tenantId,
        actorId: claim.actorId,
        actorType: 'user',
        action,
        targetId: claim.id,
      },
    });
  }
}

export class HumanOutboundDispatcher {
  private readonly lease: HumanOutboundLease;

  constructor(
    private readonly store: HumanOutboundStore,
    private readonly providers: MessagingProviderRegistry,
    deps?: Dependencies,
    lease?: HumanOutboundLease,
  ) {
    if (!lease && !deps) throw new Error('Dispatcher requires a lease');
    this.lease = lease ?? this.defaultLease(deps!);
  }

  async process(id: string, attempt: number): Promise<void> {
    if (!isUUID(id) || !Number.isInteger(attempt) || attempt < 0 || attempt >= 5)
      throw new HumanOutboundFailed();

    await this.lease(`human-outbound:${id.toLowerCase()}`, async (assertOwned) => {
      const claim = await this.store.claim(id.toLowerCase(), attempt);
      if (!claim) return;
      await assertOwned();
      if (!(await this.store.isCurrent(claim))) {
        await this.store.reject(claim, 'stale');
        return;
      }

      let providerAccepted = false;
      try {
        const provider = this.providers.resolve(claim.channel);
        await assertOwned();
        if (!(await this.store.isCurrent(claim))) {
          await this.store.reject(claim, 'stale');
          return;
        }
        const delivery = await provider.sendText({
          attemptId: claim.id,
          recipientReference: claim.recipientReference,
          senderReference: claim.senderReference,
          ...(claim.credentialsReference
            ? { credentialsReference: claim.credentialsReference }
            : {}),
          text: claim.text,
        });
        providerAccepted = true;
        if (
          !delivery.providerMessageId ||
          Number.isNaN(delivery.acceptedAt.getTime())
        )
          throw new MessagingDeliveryUnknown();
        await this.store.accept(claim, delivery);
      } catch (error) {
        if (providerAccepted || error instanceof MessagingDeliveryUnknown)
          await this.store.recordUnknownDelivery(claim);
        else await this.store.recordFailure(claim);
        throw new HumanOutboundFailed();
      }
    });
  }

  private defaultLease(deps: Dependencies): HumanOutboundLease {
    return (key, work) => new ConversationLock(deps.redis, 15_000).run(key, work);
  }
}
