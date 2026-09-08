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
}

export interface AITurnRecord {
  conversationId: string;
  customerId: string;
  modeEpoch: bigint;
  stateVersion: bigint;
  status: 'running' | AITurnOutcome;
}

export interface AITurnLedgerRepository {
  begin(input: AITurnStart): Promise<'started' | AITurnRecord>;
  finish(input: AITurnFinish): Promise<boolean>;
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
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
        ) VALUES (
          ${input.tenantId}::uuid, ${input.turnId}::uuid, ${input.conversationId}::uuid,
          ${input.customerId}::uuid, ${input.modeEpoch}, ${input.stateVersion}
        ) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`;
      if (inserted.length === 1) return 'started';
      const [existing] = await tx.$queryRaw<
        {
          conversationId: string;
          customerId: string;
          modeEpoch: bigint;
          stateVersion: bigint;
          status: AITurnRecord['status'];
        }[]
      >`SELECT conversation_id AS "conversationId", customer_id AS "customerId",
          mode_epoch AS "modeEpoch", state_version AS "stateVersion", status
        FROM ai_turns WHERE tenant_id=${input.tenantId}::uuid AND id=${input.turnId}::uuid`;
      if (!existing) throw new InvalidAITurn();
      return existing;
    });
  }

  finish(input: AITurnFinish): Promise<boolean> {
    return this.scoped(input.tenantId, async (tx) => {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE ai_turns SET status=${input.outcome}, rounds=${input.rounds},
          tool_calls=${input.toolCalls}, failure_code=${input.failureCode}, completed_at=now()
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.turnId}::uuid
          AND status='running' RETURNING id`;
      if (updated.length !== 1) return false;
      await tx.$executeRaw`
        INSERT INTO ai_usage_events (
          tenant_id, id, turn_id, provider_key, model_key, input_tokens, output_tokens, outcome
        ) VALUES (
          ${input.tenantId}::uuid, ${randomUUID()}::uuid, ${input.turnId}::uuid,
          ${input.providerKey}, ${input.modelKey}, ${input.inputTokens}, ${input.outputTokens},
          ${input.outcome}
        )`;
      return true;
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

  async finish(input: AITurnFinish): Promise<'finished' | 'already_finished'> {
    this.validateFinish(input);
    return (await this.repository.finish(input)) ? 'finished' : 'already_finished';
  }

  private validateStart(input: AITurnStart): void {
    if (
      ![input.tenantId, input.turnId, input.conversationId, input.customerId].every((id) =>
        isUUID(id),
      ) ||
      input.modeEpoch < 0n ||
      input.stateVersion < 0n
    )
      throw new InvalidAITurn();
  }

  private validateFinish(input: AITurnFinish): void {
    const failureExpected = input.outcome === 'failed' || input.outcome === 'stale';
    if (
      !isUUID(input.tenantId) ||
      !isUUID(input.turnId) ||
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
      (input.failureCode !== null && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(input.failureCode))
    )
      throw new InvalidAITurn();
  }
}
