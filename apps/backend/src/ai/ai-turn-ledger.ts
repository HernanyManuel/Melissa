import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';

export type AITurnOutcome = 'completed' | 'handoff_required' | 'failed' | 'stale';

export interface AITurnStart {
  tenantId: string;
  turnId: string;
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  stateVersion: bigint;
  leaseId?: string;
}

export interface AITurnFinish {
  tenantId: string;
  turnId: string;
  outcome: AITurnOutcome;
  rounds: number;
  toolCalls: number;
  failureCode: string | null;
  providerKey: string;
  modelKey: string;
  inputTokens: number;
  outputTokens: number;
  deliveryText?: string;
  leaseId?: string;
}

export interface AITurnRecord {
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  stateVersion: bigint;
  status: 'running' | AITurnOutcome;
  leaseId?: string | null;
}

export interface AITurnLedgerRepository {
  begin(input: AITurnStart): Promise<'started' | AITurnRecord>;
  finish(input: AITurnFinish): Promise<'finished' | 'already_finished' | 'stale'>;
}

export class InvalidAITurn extends Error {
  constructor() {
    super('Invalid AI turn');
    this.name = 'InvalidAITurn';
  }
}

@Injectable()
export class PrismaAITurnLedgerRepository implements AITurnLedgerRepository {
  constructor(private readonly deps: Dependencies) {}

  private scoped<T>(
    tenantId: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }

  async begin(input: AITurnStart): Promise<'started' | AITurnRecord> {
    return this.scoped(input.tenantId, async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ai_turns (
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version,
          execution_lease_id, execution_lease_expires_at
        ) VALUES (
          ${input.tenantId}::uuid, ${input.turnId}::uuid, ${input.conversationId}::uuid,
          ${input.customerId}::uuid, ${input.modeEpoch}, ${input.stateVersion},
          ${input.leaseId ?? null}::uuid,
          CASE WHEN ${input.leaseId ?? null}::uuid IS NULL THEN NULL ELSE now() + interval '5 minutes' END
        ) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`;
      if (inserted.length === 1) return 'started';
      const [existing] = await tx.$queryRaw<
        {
          conversationId: string;
          customerId: string;
          modeEpoch: bigint;
          stateVersion: bigint;
          status: AITurnRecord['status'];
          leaseId: string | null;
        }[]
      >`SELECT conversation_id AS "conversationId", customer_id AS "customerId",
          mode_epoch AS "modeEpoch", state_version AS "stateVersion", status,
          execution_lease_id::text AS "leaseId"
        FROM ai_turns WHERE tenant_id=${input.tenantId}::uuid AND id=${input.turnId}::uuid`;
      if (!existing) throw new InvalidAITurn();
      if (existing.status === 'running' && input.leaseId) {
        const [reclaimed] = await tx.$queryRaw<Array<{ leaseId: string }>>`
          UPDATE ai_turns
          SET execution_lease_id=${input.leaseId}::uuid,
              execution_lease_expires_at=now() + interval '5 minutes'
          WHERE tenant_id=${input.tenantId}::uuid AND id=${input.turnId}::uuid
            AND status='running'
            AND (execution_lease_id=${input.leaseId}::uuid OR execution_lease_expires_at <= now())
          RETURNING execution_lease_id::text AS "leaseId"`;
        if (reclaimed) return { ...existing, leaseId: reclaimed.leaseId };
      }
      return existing;
    });
  }

  finish(input: AITurnFinish): Promise<'finished' | 'already_finished' | 'stale'> {
    return this.scoped(input.tenantId, async (tx) => {
      const [turn] = await tx.$queryRaw<
        {
          status: AITurnRecord['status'];
          conversationId: string;
          customerId: string;
          modeEpoch: bigint;
          channelConnectionId: string;
          currentMode: string;
          currentModeEpoch: bigint;
        }[]
      >`SELECT t.status, t.conversation_id AS "conversationId",
          t.customer_id AS "customerId", t.mode_epoch AS "modeEpoch",
          c.channel_connection_id AS "channelConnectionId", c.mode AS "currentMode",
          c.mode_epoch AS "currentModeEpoch"
        FROM ai_turns t JOIN conversations c
          ON c.tenant_id=t.tenant_id AND c.id=t.conversation_id
        WHERE t.tenant_id=${input.tenantId}::uuid AND t.id=${input.turnId}::uuid
        FOR UPDATE OF t, c`;
      if (!turn || turn.status !== 'running') return 'already_finished';
      if (input.leaseId) {
        const [lease] = await tx.$queryRaw<Array<{ owned: boolean }>>`
          SELECT execution_lease_id=${input.leaseId}::uuid
            AND execution_lease_expires_at > now() AS owned
          FROM ai_turns
          WHERE tenant_id=${input.tenantId}::uuid AND id=${input.turnId}::uuid
          ${Prisma.raw(input.leaseId ? `AND execution_lease_id='${input.leaseId}'::uuid` : '')}`;
        if (!lease?.owned) return 'stale';
      }
      const deliveryStale =
        input.deliveryText !== undefined &&
        (turn.currentMode !== 'AI_ACTIVE' || turn.currentModeEpoch !== turn.modeEpoch);
      const outcome = deliveryStale ? 'stale' : input.outcome;
      const failureCode = deliveryStale ? 'conversation_stale' : input.failureCode;
      await tx.$executeRaw`
        UPDATE ai_turns SET status=${outcome}, rounds=${input.rounds},
          tool_calls=${input.toolCalls}, failure_code=${failureCode}, completed_at=now()
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.turnId}::uuid`;
      await tx.$executeRaw`
        INSERT INTO ai_usage_events (
          tenant_id, id, turn_id, provider_key, model_key, input_tokens, output_tokens, outcome
        ) VALUES (
          ${input.tenantId}::uuid, ${randomUUID()}::uuid, ${input.turnId}::uuid,
          ${input.providerKey}, ${input.modelKey}, ${input.inputTokens}, ${input.outputTokens},
          ${outcome}
        )`;
      if (!deliveryStale && input.deliveryText !== undefined) {
        const intentId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO ai_outbound_intents (
            tenant_id, id, turn_id, conversation_id, customer_id,
            channel_connection_id, mode_epoch, content_text
          ) VALUES (
            ${input.tenantId}::uuid, ${intentId}::uuid, ${input.turnId}::uuid,
            ${turn.conversationId}::uuid, ${turn.customerId}::uuid,
            ${turn.channelConnectionId}::uuid, ${turn.modeEpoch}, ${input.deliveryText}
          )`;
        await tx.$executeRaw`
          INSERT INTO ai_outbound_dispatch (tenant_id, id)
          VALUES (${input.tenantId}::uuid, ${intentId}::uuid)`;
      }
      return deliveryStale ? 'stale' : 'finished';
    });
  }
}

export class AITurnLedger {
  constructor(private readonly repository: AITurnLedgerRepository) {}

  async begin(input: AITurnStart): Promise<'started' | 'running' | 'finished'> {
    this.validateStart(input);
    const result = await this.repository.begin(input);
    if (result === 'started') return result;
    if (
      result.conversationId !== input.conversationId ||
      result.customerId !== input.customerId ||
      result.modeEpoch !== input.modeEpoch ||
      result.stateVersion !== input.stateVersion
    )
      throw new InvalidAITurn();
    return result.status === 'running' ? 'running' : 'finished';
  }

  async finish(input: AITurnFinish): Promise<'finished' | 'already_finished' | 'stale'> {
    this.validateFinish(input);
    return this.repository.finish(input);
  }

  private validateStart(input: AITurnStart): void {
    if (
      ![input.tenantId, input.turnId, input.conversationId, input.customerId].every((id) =>
        isUUID(id),
      ) ||
      input.modeEpoch < 0n ||
      input.stateVersion < 0n ||
      (input.leaseId !== undefined && !isUUID(input.leaseId))
    )
      throw new InvalidAITurn();
  }

  private validateFinish(input: AITurnFinish): void {
    const failureExpected = input.outcome === 'failed' || input.outcome === 'stale';
    if (
      !isUUID(input.tenantId) ||
      !isUUID(input.turnId) ||
      (input.leaseId !== undefined && !isUUID(input.leaseId)) ||
      !Number.isInteger(input.rounds) ||
      input.rounds < 0 ||
      input.rounds > 4 ||
      !Number.isInteger(input.toolCalls) ||
      input.toolCalls < 0 ||
      input.toolCalls > 8 ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.providerKey) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.modelKey) ||
      ![input.inputTokens, input.outputTokens].every(
        (tokens) => Number.isInteger(tokens) && tokens >= 0 && tokens <= 100_000_000,
      ) ||
      failureExpected !== (input.failureCode !== null) ||
      ((input.outcome === 'completed' || input.outcome === 'handoff_required') &&
        input.rounds === 0) ||
      (input.failureCode !== null && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(input.failureCode)) ||
      (input.deliveryText !== undefined &&
        (input.outcome !== 'completed' ||
          Array.from(input.deliveryText.trim()).length < 1 ||
          Array.from(input.deliveryText).length > 4096 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Surrogate}]/u.test(input.deliveryText)))
    )
      throw new InvalidAITurn();
  }
}
