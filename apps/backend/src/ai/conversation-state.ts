import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';

export type ConversationMode =
  | 'AI_ACTIVE'
  | 'WAITING_HUMAN'
  | 'HUMAN_ACTIVE'
  | 'AI_PAUSED'
  | 'CLOSED';
export type ConversationIntent = 'business_info' | 'services' | 'booking' | 'handoff' | null;
export type ConversationStage =
  | 'idle'
  | 'collecting_service'
  | 'collecting_date'
  | 'collecting_staff'
  | 'confirming'
  | 'completed';

export interface ConversationStateV1 {
  version: 1;
  intent: ConversationIntent;
  stage: ConversationStage;
  serviceId: string | null;
  date: string | null;
  staffId: string | null;
}

export interface ConversationVersionSnapshot {
  mode: ConversationMode;
  modeEpoch: bigint;
  stateVersion: bigint;
  state: ConversationStateV1;
}

export interface StateCommit {
  tenantId: string;
  conversationId: string;
  customerId: string;
  expectedModeEpoch: bigint;
  expectedStateVersion: bigint;
  state: ConversationStateV1;
}

export interface ConversationStateRepository {
  load(
    tenantId: string,
    conversationId: string,
    customerId: string,
  ): Promise<ConversationVersionSnapshot | null>;
  commit(input: StateCommit): Promise<boolean>;
  changeMode(
    tenantId: string,
    conversationId: string,
    expectedModeEpoch: bigint,
    from: ConversationMode,
    to: ConversationMode,
  ): Promise<boolean>;
}

export class StaleConversationState extends Error {
  constructor() {
    super('Conversation state is stale');
    this.name = 'StaleConversationState';
  }
}

const INTENTS = new Set<ConversationIntent>([
  null,
  'business_info',
  'services',
  'booking',
  'handoff',
]);
const STAGES = new Set<ConversationStage>([
  'idle',
  'collecting_service',
  'collecting_date',
  'collecting_staff',
  'confirming',
  'completed',
]);
const KEYS = ['version', 'intent', 'stage', 'serviceId', 'date', 'staffId'];
const TRANSITIONS: Record<ConversationMode, readonly ConversationMode[]> = {
  AI_PAUSED: ['AI_ACTIVE', 'CLOSED'],
  AI_ACTIVE: ['AI_PAUSED', 'WAITING_HUMAN', 'CLOSED'],
  WAITING_HUMAN: ['HUMAN_ACTIVE', 'AI_PAUSED', 'CLOSED'],
  HUMAN_ACTIVE: ['AI_ACTIVE', 'AI_PAUSED', 'CLOSED'],
  CLOSED: [],
};
const MODES = new Set<ConversationMode>(Object.keys(TRANSITIONS) as ConversationMode[]);

function validDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateConversationState(value: unknown): ConversationStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StaleConversationState();
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== KEYS.length ||
    KEYS.some((key) => !(key in state)) ||
    state.version !== 1 ||
    !INTENTS.has(state.intent as ConversationIntent) ||
    !STAGES.has(state.stage as ConversationStage) ||
    ![state.serviceId, state.staffId].every(
      (id) => id === null || (typeof id === 'string' && isUUID(id)),
    ) ||
    (state.date !== null && !validDate(state.date))
  )
    throw new StaleConversationState();
  return structuredClone(value) as ConversationStateV1;
}

@Injectable()
export class PrismaConversationStateRepository implements ConversationStateRepository {
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

  load(
    tenantId: string,
    conversationId: string,
    customerId: string,
  ): Promise<ConversationVersionSnapshot | null> {
    return this.scoped(tenantId, async (tx) => {
      const row = await tx.conversation.findFirst({
        where: { tenantId, id: conversationId, customerId },
        select: { mode: true, modeEpoch: true, stateVersion: true, state: true },
      });
      if (!row) return null;
      return {
        mode: row.mode as ConversationMode,
        modeEpoch: row.modeEpoch,
        stateVersion: row.stateVersion,
        state: validateConversationState(row.state),
      };
    });
  }

  commit(input: StateCommit): Promise<boolean> {
    return this.scoped(
      input.tenantId,
      async (tx) =>
        (
          await tx.conversation.updateMany({
            where: {
              tenantId: input.tenantId,
              id: input.conversationId,
              customerId: input.customerId,
              mode: 'AI_ACTIVE',
              modeEpoch: input.expectedModeEpoch,
              stateVersion: input.expectedStateVersion,
            },
            data: {
              state: input.state as unknown as Prisma.InputJsonValue,
              stateVersion: { increment: 1 },
            },
          })
        ).count === 1,
    );
  }

  changeMode(
    tenantId: string,
    conversationId: string,
    expectedModeEpoch: bigint,
    from: ConversationMode,
    to: ConversationMode,
  ): Promise<boolean> {
    return this.scoped(
      tenantId,
      async (tx) =>
        (
          await tx.conversation.updateMany({
            where: { tenantId, id: conversationId, mode: from, modeEpoch: expectedModeEpoch },
            data: { mode: to },
          })
        ).count === 1,
    );
  }
}

export class ConversationStateService {
  constructor(private readonly repository: ConversationStateRepository) {}

  async commit(input: StateCommit): Promise<void> {
    this.validateScope(input.tenantId, input.conversationId, input.customerId);
    const state = validateConversationState(input.state);
    if (!(await this.repository.commit({ ...input, state }))) throw new StaleConversationState();
  }

  async changeMode(
    tenantId: string,
    conversationId: string,
    expectedModeEpoch: bigint,
    from: ConversationMode,
    to: ConversationMode,
  ): Promise<void> {
    this.validateScope(tenantId, conversationId);
    if (
      !MODES.has(from) ||
      !MODES.has(to) ||
      !TRANSITIONS[from].includes(to) ||
      !(await this.repository.changeMode(tenantId, conversationId, expectedModeEpoch, from, to))
    )
      throw new StaleConversationState();
  }

  private validateScope(...ids: string[]): void {
    if (!ids.every((id) => isUUID(id))) throw new StaleConversationState();
  }
}
