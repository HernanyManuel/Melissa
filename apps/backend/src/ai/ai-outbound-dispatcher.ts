import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { MessagingDeliveryUnknown } from '../channels/messaging-provider';
import { MessagingProviderRegistry } from '../channels/messaging-provider-registry';
import { ProviderChannel } from '../channels/messaging-provider-registry';
import { Dependencies } from '../dependencies';
import { ConversationLock } from '../messaging/conversation-lock';

type RejectReason = 'stale' | 'unauthorized';
type ClaimResult = AIAutomaticOutboundClaim | null;
type ScopedRun<T> = (tx: Prisma.TransactionClient) => Promise<T>;
type AssertOwned = () => Promise<void>;
type LeaseWork = (assertOwned: AssertOwned) => Promise<void>;

interface DispatchRow {
  id: string;
  tenantId: string;
  conversationId: string;
  customerId: string;
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

export interface AIAutomaticOutboundClaim {
  id: string;
  tenantId: string;
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  attempt: number;
  recipientReference: string;
  senderReference: string;
  credentialsReference: string | null;
  text: string;
  channel: ProviderChannel;
}

export interface AIAutomaticOutboundStore {
  claim(id: string, attempt: number): Promise<ClaimResult>;
  isCurrent(claim: AIAutomaticOutboundClaim): Promise<boolean>;
  reject(claim: AIAutomaticOutboundClaim, reason: RejectReason): Promise<void>;
  accept(claim: AIAutomaticOutboundClaim): Promise<void>;
  recordFailure(claim: AIAutomaticOutboundClaim): Promise<void>;
  recordUnknownDelivery(claim: AIAutomaticOutboundClaim): Promise<void>;
}

export type AIAutomaticOutboundLease = (key: string, work: LeaseWork) => Promise<boolean>;

export class AIAutomaticOutboundFailed extends Error {
  constructor() {
    super('Automatic outbound processing failed');
    this.name = 'AIAutomaticOutboundFailed';
  }
}

export class PrismaAIAutomaticOutboundStore implements AIAutomaticOutboundStore {
  constructor(private readonly deps: Dependencies) {}

  private scoped<T>(tenantId: string, run: ScopedRun<T>): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }

  async claim(id: string, attempt: number): Promise<ClaimResult> {
    const [route] = await this.deps.db.$queryRaw<{ tenantId: string }[]>`
      SELECT tenant_id AS "tenantId"
      FROM ai_outbound_dispatch
      WHERE id=${id}::uuid`;
    if (!route) return null;
    return this.scoped(route.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<DispatchRow[]>`
        SELECT d.id, d.tenant_id AS "tenantId",
          i.conversation_id AS "conversationId",
          i.customer_id AS "customerId", i.mode_epoch AS "modeEpoch",
          d.attempts, d.state, d.next_attempt_at AS "nextAttemptAt",
          i.content_text AS text, cu.phone_e164 AS "recipientReference",
          ch.external_phone_id AS "senderReference",
          ch.credentials_reference AS "credentialsReference",
          c.mode AS "conversationMode", c.mode_epoch AS "currentModeEpoch",
          c.status AS "conversationStatus", cu.deleted_at AS "customerDeletedAt",
          ch.channel_type AS "channelType", ch.mode AS "channelMode",
          ch.status AS "channelStatus"
        FROM ai_outbound_dispatch d
        JOIN ai_outbound_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
        JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
        JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.id=i.customer_id
        JOIN channel_connections ch
          ON ch.tenant_id=i.tenant_id AND ch.id=i.channel_connection_id
        WHERE d.tenant_id=${route.tenantId}::uuid AND d.id=${id}::uuid`;
      if (!this.isDue(row, attempt)) return null;
      const claim = this.toClaim(row);
      if (!this.isAuthorized(row)) {
        await this.rejectInTransaction(tx, claim, 'unauthorized');
        return null;
      }
      return claim;
    });
  }

  isCurrent(claim: AIAutomaticOutboundClaim): Promise<boolean> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ current: boolean }[]>`
        SELECT EXISTS(
          SELECT 1
          FROM ai_outbound_dispatch d
          JOIN ai_outbound_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
          JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
          JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.id=i.customer_id
          JOIN channel_connections ch
            ON ch.tenant_id=i.tenant_id AND ch.id=i.channel_connection_id
          WHERE d.tenant_id=${claim.tenantId}::uuid
            AND d.id=${claim.id}::uuid AND d.state='pending'
            AND d.attempts=${claim.attempt} AND d.next_attempt_at <= now()
            AND i.conversation_id=${claim.conversationId}::uuid
            AND i.customer_id=${claim.customerId}::uuid
            AND i.mode_epoch=${claim.modeEpoch}
            AND c.mode='AI_ACTIVE' AND c.mode_epoch=i.mode_epoch
            AND c.status NOT IN ('closed','archived')
            AND cu.deleted_at IS NULL
            AND ch.mode='live' AND ch.status='active'
            AND ch.external_phone_id=${claim.senderReference}
            AND ch.credentials_reference IS NOT DISTINCT FROM ${claim.credentialsReference}
        ) AS current`;
      return row?.current === true;
    });
  }

  reject(claim: AIAutomaticOutboundClaim, reason: RejectReason): Promise<void> {
    return this.scoped(claim.tenantId, (tx) => this.rejectInTransaction(tx, claim, reason));
  }

  accept(claim: AIAutomaticOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE ai_outbound_dispatch SET state='accepted'
        WHERE tenant_id=${claim.tenantId}::uuid
          AND id=${claim.id}::uuid AND state='pending'`;
      if (updated === 1) await this.audit(tx, claim, 'ai.outbound_accepted');
    });
  }

  recordFailure(claim: AIAutomaticOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [current] = await tx.$queryRaw<{ state: string; attempts: number }[]>`
        SELECT state, attempts FROM ai_outbound_dispatch
        WHERE tenant_id=${claim.tenantId}::uuid
          AND id=${claim.id}::uuid FOR UPDATE`;
      if (!current || current.state !== 'pending' || current.attempts !== claim.attempt) return;
      const attempts = claim.attempt + 1;
      const terminal = attempts >= 5;
      const state = terminal ? 'failed' : 'pending';
      const delay = Math.min(60_000, 1000 * 2 ** claim.attempt);
      const nextAttemptAt = new Date(Date.now() + delay);
      await tx.$executeRaw`
        UPDATE ai_outbound_dispatch
        SET attempts=${attempts}, state=${state}, next_attempt_at=${nextAttemptAt}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid`;
      const action = terminal ? 'ai.outbound_failed' : 'ai.outbound_retry';
      await this.audit(tx, claim, action);
    });
  }

  recordUnknownDelivery(claim: AIAutomaticOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE ai_outbound_dispatch
        SET attempts=${claim.attempt + 1}, state='failed'
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}`;
      if (updated === 1) await this.audit(tx, claim, 'ai.outbound_delivery_unknown');
    });
  }

  private isDue(row: DispatchRow | undefined, attempt: number): row is DispatchRow {
    if (!row) return false;
    if (row.state !== 'pending') return false;
    if (row.attempts !== attempt) return false;
    return row.nextAttemptAt <= new Date();
  }

  private isAuthorized(row: DispatchRow): boolean {
    if (row.conversationMode !== 'AI_ACTIVE') return false;
    if (row.currentModeEpoch !== row.modeEpoch) return false;
    if (['closed', 'archived'].includes(row.conversationStatus)) return false;
    if (row.customerDeletedAt !== null) return false;
    if (row.channelMode !== 'live') return false;
    if (row.channelStatus !== 'active') return false;
    if (row.channelType === 'whatsapp') {
      if (!row.senderReference.trim()) return false;
      if (!row.credentialsReference?.trim()) return false;
    }
    return true;
  }

  private toClaim(row: DispatchRow): AIAutomaticOutboundClaim {
    return {
      id: row.id,
      tenantId: row.tenantId,
      conversationId: row.conversationId,
      customerId: row.customerId,
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
    claim: AIAutomaticOutboundClaim,
    reason: RejectReason,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE ai_outbound_dispatch SET state='rejected'
      WHERE tenant_id=${claim.tenantId}::uuid
        AND id=${claim.id}::uuid AND state='pending'`;
    if (updated === 1) await this.audit(tx, claim, `ai.outbound_${reason}`);
  }

  private async audit(
    tx: Prisma.TransactionClient,
    claim: AIAutomaticOutboundClaim,
    action: string,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO audit_events
        (tenant_id, actor_id, actor_type, action, target_id)
      VALUES (${claim.tenantId}::uuid, NULL, 'ai', ${action}, ${claim.id}::uuid)`;
  }
}

export class AIAutomaticOutboundDispatcher {
  private readonly lease: AIAutomaticOutboundLease;

  constructor(
    private readonly store: AIAutomaticOutboundStore,
    private readonly providers: MessagingProviderRegistry,
    deps?: Dependencies,
    lease?: AIAutomaticOutboundLease,
  ) {
    if (!lease && !deps) throw new Error('Dispatcher requires a lease');
    this.lease = lease ?? this.defaultLease(deps!);
  }

  async process(id: string, attempt: number): Promise<void> {
    if (!isUUID(id)) throw new AIAutomaticOutboundFailed();
    if (!Number.isInteger(attempt)) throw new AIAutomaticOutboundFailed();
    if (attempt < 0 || attempt >= 5) throw new AIAutomaticOutboundFailed();
    const normalizedId = id.toLowerCase();
    await this.lease(`ai-outbound:${normalizedId}`, async (assertOwned) => {
      const claim = await this.store.claim(normalizedId, attempt);
      if (!claim) return;
      await assertOwned();
      if (!(await this.store.isCurrent(claim))) {
        await this.store.reject(claim, 'stale');
        return;
      }
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
        if (!this.validReceipt(delivery)) throw new Error('Invalid receipt');
        await this.store.accept(claim);
      } catch (error) {
        if (error instanceof MessagingDeliveryUnknown) await this.store.recordUnknownDelivery(claim);
        else await this.store.recordFailure(claim);
        throw new AIAutomaticOutboundFailed();
      }
    });
  }

  private defaultLease(deps: Dependencies): AIAutomaticOutboundLease {
    return (key, work) => new ConversationLock(deps.redis, 15_000).run(key, work);
  }

  private validReceipt(input: { providerMessageId: string; acceptedAt: Date }): boolean {
    if (input.providerMessageId.length < 1) return false;
    return !Number.isNaN(input.acceptedAt.getTime());
  }
}
