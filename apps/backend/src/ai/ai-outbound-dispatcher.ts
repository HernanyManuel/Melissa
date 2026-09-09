import { isUUID } from 'class-validator';
import { Prisma } from '@prisma/client';
import { Dependencies } from '../dependencies';
import {
  MessagingProviderRegistry,
  ProviderChannel,
} from '../channels/messaging-provider-registry';
import { ConversationLock } from '../messaging/conversation-lock';

export interface AIAutomaticOutboundClaim {
  id: string;
  tenantId: string;
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  attempt: number;
  recipientReference: string;
  text: string;
  channel: ProviderChannel;
}

export interface AIAutomaticOutboundStore {
  claim(id: string, attempt: number): Promise<AIAutomaticOutboundClaim | null>;
  isCurrent(claim: AIAutomaticOutboundClaim): Promise<boolean>;
  reject(
    claim: AIAutomaticOutboundClaim,
    reason: 'stale' | 'unauthorized',
  ): Promise<void>;
  accept(claim: AIAutomaticOutboundClaim): Promise<void>;
  recordFailure(claim: AIAutomaticOutboundClaim): Promise<void>;
}

export type AIAutomaticOutboundLease = (
  key: string,
  work: (assertOwned: () => Promise<void>) => Promise<void>,
) => Promise<boolean>;

export class AIAutomaticOutboundFailed extends Error {
  constructor() {
    super('Automatic outbound processing failed');
    this.name = 'AIAutomaticOutboundFailed';
  }
}

export class PrismaAIAutomaticOutboundStore implements AIAutomaticOutboundStore {
  constructor(private readonly deps: Dependencies) {}

  private scoped<T>(
    tenantId: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }

  async claim(
    id: string,
    attempt: number,
  ): Promise<AIAutomaticOutboundClaim | null> {
    const [route] = await this.deps.db.$queryRaw<Array<{ tenantId: string }>>`
      SELECT tenant_id AS "tenantId" FROM ai_outbound_dispatch WHERE id=${id}::uuid`;
    if (!route) return null;
    return this.scoped(route.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<{
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
          conversationMode: string;
          currentModeEpoch: bigint;
          conversationStatus: string;
          customerDeletedAt: Date | null;
          channelType: string;
          channelMode: string;
          channelStatus: string;
        }>
      >`
        SELECT d.id, d.tenant_id AS "tenantId", i.conversation_id AS "conversationId",
          i.customer_id AS "customerId", i.mode_epoch AS "modeEpoch", d.attempts, d.state,
          d.next_attempt_at AS "nextAttemptAt", i.content_text AS text,
          cu.phone_e164 AS "recipientReference", c.mode AS "conversationMode",
          c.mode_epoch AS "currentModeEpoch", c.status AS "conversationStatus",
          cu.deleted_at AS "customerDeletedAt", ch.channel_type AS "channelType",
          ch.mode AS "channelMode", ch.status AS "channelStatus"
        FROM ai_outbound_dispatch d
        JOIN ai_outbound_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
        JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
        JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.id=i.customer_id
        JOIN channel_connections ch ON ch.tenant_id=i.tenant_id AND ch.id=i.channel_connection_id
        WHERE d.tenant_id=${route.tenantId}::uuid AND d.id=${id}::uuid`;
      if (
        !row ||
        row.state !== 'pending' ||
        row.attempts !== attempt ||
        row.nextAttemptAt > new Date()
      )
        return null;
      const claim: AIAutomaticOutboundClaim = {
        id: row.id,
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        customerId: row.customerId,
        modeEpoch: row.modeEpoch,
        attempt: row.attempts,
        recipientReference: row.recipientReference,
        text: row.text,
        channel: {
          mode: row.channelMode,
          channelType: row.channelType,
          status: row.channelStatus,
        },
      };
      if (
        row.conversationMode !== 'AI_ACTIVE' ||
        row.currentModeEpoch !== row.modeEpoch ||
        ['closed', 'archived'].includes(row.conversationStatus) ||
        row.customerDeletedAt !== null ||
        row.channelMode !== 'live' ||
        row.channelStatus !== 'active'
      ) {
        await this.rejectInTransaction(tx, claim, 'unauthorized');
        return null;
      }
      return claim;
    });
  }

  isCurrent(claim: AIAutomaticOutboundClaim): Promise<boolean> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ current: boolean }>>`
        SELECT EXISTS(
          SELECT 1
          FROM ai_outbound_dispatch d
          JOIN ai_outbound_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
          JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
          JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.id=i.customer_id
          JOIN channel_connections ch ON ch.tenant_id=i.tenant_id AND ch.id=i.channel_connection_id
          WHERE d.tenant_id=${claim.tenantId}::uuid AND d.id=${claim.id}::uuid
            AND d.state='pending' AND d.attempts=${claim.attempt}
            AND d.next_attempt_at <= now()
            AND i.conversation_id=${claim.conversationId}::uuid
            AND i.customer_id=${claim.customerId}::uuid AND i.mode_epoch=${claim.modeEpoch}
            AND c.mode='AI_ACTIVE' AND c.mode_epoch=i.mode_epoch
            AND c.status NOT IN ('closed','archived') AND cu.deleted_at IS NULL
            AND ch.mode='live' AND ch.status='active'
        ) AS current`;
      return row?.current === true;
    });
  }

  reject(
    claim: AIAutomaticOutboundClaim,
    reason: 'stale' | 'unauthorized',
  ): Promise<void> {
    return this.scoped(claim.tenantId, (tx) =>
      this.rejectInTransaction(tx, claim, reason),
    );
  }

  private async rejectInTransaction(
    tx: Prisma.TransactionClient,
    claim: AIAutomaticOutboundClaim,
    reason: 'stale' | 'unauthorized',
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE ai_outbound_dispatch SET state='rejected'
      WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid AND state='pending'`;
    if (updated === 1)
      await tx.$executeRaw`
        INSERT INTO audit_events (tenant_id, actor_id, actor_type, action, target_id)
        VALUES (${claim.tenantId}::uuid, NULL, 'ai', ${`ai.outbound_${reason}`}, ${claim.id}::uuid)`;
  }

  accept(claim: AIAutomaticOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE ai_outbound_dispatch SET state='accepted'
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid AND state='pending'`;
      if (updated === 1)
        await tx.$executeRaw`
          INSERT INTO audit_events (tenant_id, actor_id, actor_type, action, target_id)
          VALUES (${claim.tenantId}::uuid, NULL, 'ai', 'ai.outbound_accepted', ${claim.id}::uuid)`;
    });
  }

  recordFailure(claim: AIAutomaticOutboundClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [current] = await tx.$queryRaw<
        Array<{ state: string; attempts: number }>
      >`
        SELECT state, attempts FROM ai_outbound_dispatch
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid FOR UPDATE`;
      if (!current || current.state !== 'pending' || current.attempts !== claim.attempt)
        return;
      const attempts = claim.attempt + 1;
      const terminal = attempts >= 5;
      await tx.$executeRaw`
        UPDATE ai_outbound_dispatch
        SET attempts=${attempts}, state=${terminal ? 'failed' : 'pending'},
          next_attempt_at=${new Date(Date.now() + Math.min(60_000, 1000 * 2 ** claim.attempt))}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO audit_events (tenant_id, actor_id, actor_type, action, target_id)
        VALUES (${claim.tenantId}::uuid, NULL, 'ai',
          ${terminal ? 'ai.outbound_failed' : 'ai.outbound_retry'}, ${claim.id}::uuid)`;
    });
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
    if (!lease && !deps)
      throw new Error('Automatic outbound dispatcher requires a lease');
    this.lease =
      lease ?? ((key, work) => new ConversationLock(deps!.redis, 15_000).run(key, work));
  }

  async process(id: string, attempt: number): Promise<void> {
    if (!isUUID(id) || !Number.isInteger(attempt) || attempt < 0 || attempt >= 5)
      throw new AIAutomaticOutboundFailed();
    await this.lease(`ai-outbound:${id.toLowerCase()}`, async (assertOwned) => {
      const claim = await this.store.claim(id.toLowerCase(), attempt);
      if (!claim) return;
      await assertOwned();
      if (!(await this.store.isCurrent(claim))) {
        await this.store.reject(claim, 'stale');
        return;
      }
      let provider;
      try {
        provider = this.providers.resolve(claim.channel);
        await assertOwned();
        if (!(await this.store.isCurrent(claim))) {
          await this.store.reject(claim, 'stale');
          return;
        }
        const delivery = await provider.sendText({
          attemptId: claim.id,
          recipientReference: claim.recipientReference,
          text: claim.text,
        });
        if (
          typeof delivery.providerMessageId !== 'string' ||
          delivery.providerMessageId.length < 1 ||
          !(delivery.acceptedAt instanceof Date) ||
          Number.isNaN(delivery.acceptedAt.getTime())
        )
          throw new Error('Invalid provider receipt');
        await this.store.accept(claim);
      } catch {
        await this.store.recordFailure(claim);
        throw new AIAutomaticOutboundFailed();
      }
    });
  }
}
