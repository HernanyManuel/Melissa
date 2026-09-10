import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { ConversationTurnRequest, ConversationTurnResult } from './conversation-turn-coordinator';
import { AITurnJobProcessor } from './ai-turn-queue';

export interface AITurnClaim {
  id: string;
  tenantId: string;
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  stateVersion: bigint;
  attempt: number;
}

export interface AITurnCoordinatorRunner {
  run(request: ConversationTurnRequest): Promise<ConversationTurnResult>;
}

export interface AITurnDispatchStore {
  claim(id: string, attempt: number): Promise<AITurnClaim | null>;
  complete(claim: AITurnClaim): Promise<void>;
  reject(claim: AITurnClaim): Promise<void>;
  fail(claim: AITurnClaim): Promise<void>;
  defer(claim: AITurnClaim): Promise<void>;
  settleFinished(claim: AITurnClaim): Promise<void>;
  recordFailure(claim: AITurnClaim): Promise<void>;
}

export class AITurnProcessingFailed extends Error {
  constructor() {
    super('AI turn processing failed');
    this.name = 'AITurnProcessingFailed';
  }
}

export class PrismaAITurnDispatchStore implements AITurnDispatchStore {
  constructor(private readonly deps: Pick<Dependencies, 'db'>) {}

  private scoped<T>(tenantId: string, run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }

  async claim(id: string, attempt: number): Promise<AITurnClaim | null> {
    const [route] = await this.deps.db.$queryRaw<Array<{ tenantId: string }>>`
      SELECT tenant_id AS "tenantId" FROM ai_turn_dispatch WHERE id=${id}::uuid`;
    if (!route) return null;
    return this.scoped(route.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          conversationId: string;
          customerId: string;
          modeEpoch: bigint;
          stateVersion: bigint;
          attempts: number;
          state: string;
          nextAttemptAt: Date;
          conversationMode: string;
          currentModeEpoch: bigint;
          currentStateVersion: bigint;
          conversationStatus: string;
          customerDeletedAt: Date | null;
          channelType: string;
          channelMode: string;
          channelStatus: string;
        }>
      >`
        SELECT d.id, d.tenant_id AS "tenantId", i.conversation_id AS "conversationId",
          i.customer_id AS "customerId", i.mode_epoch AS "modeEpoch",
          i.state_version AS "stateVersion", d.attempts, d.state,
          d.next_attempt_at AS "nextAttemptAt", c.mode AS "conversationMode",
          c.mode_epoch AS "currentModeEpoch", c.state_version AS "currentStateVersion",
          c.status AS "conversationStatus", cu.deleted_at AS "customerDeletedAt",
          ch.channel_type AS "channelType", ch.mode AS "channelMode", ch.status AS "channelStatus"
        FROM ai_turn_dispatch d
        JOIN ai_turn_intents i ON i.tenant_id=d.tenant_id AND i.id=d.id
        JOIN conversations c ON c.tenant_id=i.tenant_id AND c.id=i.conversation_id
        JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.id=i.customer_id
        JOIN channel_connections ch ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_connection_id
        WHERE d.tenant_id=${route.tenantId}::uuid AND d.id=${id}::uuid`;
      if (!row || row.state !== 'pending' || row.attempts !== attempt || row.nextAttemptAt > new Date())
        return null;
      const claim: AITurnClaim = {
        id: row.id,
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        customerId: row.customerId,
        modeEpoch: row.modeEpoch,
        stateVersion: row.stateVersion,
        attempt: row.attempts,
      };
      const authorized =
        row.conversationMode === 'AI_ACTIVE' &&
        row.currentModeEpoch === row.modeEpoch &&
        row.currentStateVersion === row.stateVersion &&
        !['closed', 'archived'].includes(row.conversationStatus) &&
        row.customerDeletedAt === null &&
        row.channelType === 'whatsapp' &&
        row.channelMode === 'live' &&
        row.channelStatus === 'active';
      if (!authorized) {
        await this.setState(tx, claim, 'rejected', 'ai.turn_rejected');
        return null;
      }
      return claim;
    });
  }

  complete(claim: AITurnClaim): Promise<void> {
    return this.transition(claim, 'processed', 'ai.turn_processed');
  }

  reject(claim: AITurnClaim): Promise<void> {
    return this.transition(claim, 'rejected', 'ai.turn_rejected');
  }

  fail(claim: AITurnClaim): Promise<void> {
    return this.transition(claim, 'failed', 'ai.turn_failed');
  }

  defer(claim: AITurnClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE ai_turn_dispatch SET next_attempt_at=${new Date(Date.now() + 1000)}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}`;
    });
  }

  settleFinished(claim: AITurnClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [turn] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM ai_turns
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid`;
      if (!turn || turn.status === 'running') {
        await tx.$executeRaw`
          UPDATE ai_turn_dispatch SET next_attempt_at=${new Date(Date.now() + 1000)}
          WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
            AND state='pending' AND attempts=${claim.attempt}`;
        return;
      }
      if (turn.status === 'completed' || turn.status === 'handoff_required')
        await this.setState(tx, claim, 'processed', 'ai.turn_processed');
      else if (turn.status === 'stale')
        await this.setState(tx, claim, 'rejected', 'ai.turn_rejected');
      else if (turn.status === 'failed')
        await this.setState(tx, claim, 'failed', 'ai.turn_failed');
      else throw new AITurnProcessingFailed();
    });
  }

  recordFailure(claim: AITurnClaim): Promise<void> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [current] = await tx.$queryRaw<Array<{ state: string; attempts: number }>>`
        SELECT state, attempts FROM ai_turn_dispatch
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid FOR UPDATE`;
      if (!current || current.state !== 'pending' || current.attempts !== claim.attempt) return;
      const attempts = claim.attempt + 1;
      const terminal = attempts >= 5;
      await tx.$executeRaw`
        UPDATE ai_turn_dispatch
        SET attempts=${attempts}, state=${terminal ? 'failed' : 'pending'},
          next_attempt_at=${new Date(Date.now() + Math.min(60_000, 1000 * 2 ** attempts))}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}`;
      await tx.auditEvent.create({
        data: {
          tenantId: claim.tenantId,
          actorId: null,
          actorType: 'system',
          action: terminal ? 'ai.turn_failed' : 'ai.turn_retry',
          targetId: claim.id,
        },
      });
    });
  }

  private transition(claim: AITurnClaim, state: 'processed' | 'rejected' | 'failed', action: string) {
    return this.scoped(claim.tenantId, (tx) => this.setState(tx, claim, state, action));
  }

  private async setState(
    tx: Prisma.TransactionClient,
    claim: AITurnClaim,
    state: 'processed' | 'rejected' | 'failed',
    action: string,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE ai_turn_dispatch SET state=${state}
      WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
        AND state='pending' AND attempts=${claim.attempt}`;
    if (updated === 1)
      await tx.auditEvent.create({
        data: {
          tenantId: claim.tenantId,
          actorId: null,
          actorType: 'system',
          action,
          targetId: claim.id,
        },
      });
  }
}

export class AITurnProcessor implements AITurnJobProcessor {
  private readonly capabilities: readonly string[];
  private readonly toolNames: readonly string[];

  constructor(
    private readonly store: AITurnDispatchStore,
    private readonly coordinator: AITurnCoordinatorRunner,
    capabilities: readonly string[],
    toolNames: readonly string[],
  ) {
    this.capabilities = Object.freeze([...capabilities]);
    this.toolNames = Object.freeze([...toolNames]);
  }

  async process(id: string, attempt: number): Promise<void> {
    if (!isUUID(id) || !Number.isInteger(attempt) || attempt < 0 || attempt >= 5)
      throw new AITurnProcessingFailed();
    const claim = await this.store.claim(id.toLowerCase(), attempt);
    if (!claim) return;
    try {
      const result = await this.coordinator.run({
        tenantId: claim.tenantId,
        conversationId: claim.conversationId,
        customerId: claim.customerId,
        correlationId: claim.id,
        turnId: claim.id,
        expectedModeEpoch: claim.modeEpoch,
        expectedStateVersion: claim.stateVersion,
        executionMode: 'live',
        capabilities: this.capabilities,
        toolNames: this.toolNames,
      });
      if (result.status === 'completed' || result.status === 'handoff_required') {
        await this.store.complete(claim);
        return;
      }
      if (result.status === 'stale') {
        await this.store.reject(claim);
        return;
      }
      if (result.status === 'failed') {
        await this.store.fail(claim);
        return;
      }
      if (result.reason === 'already_running') {
        await this.store.defer(claim);
        return;
      }
      await this.store.settleFinished(claim);
    } catch {
      await this.store.recordFailure(claim);
      throw new AITurnProcessingFailed();
    }
  }
}
