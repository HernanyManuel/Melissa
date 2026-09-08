import { isUUID } from 'class-validator';
import { AIContextBuilder, AIContextUnavailable } from './ai-context-builder';
import { AICompletionFailed } from './ai-provider';
import { AITurnLedger } from './ai-turn-ledger';
import {
  ConversationEngine,
  ConversationEngineResult,
  ConversationExecutionStale,
} from './conversation-engine';
import { ToolRegistry } from './tool-registry';

export interface ConversationTurnRequest {
  tenantId: string;
  conversationId: string;
  customerId: string;
  correlationId: string;
  turnId: string;
  expectedModeEpoch: bigint;
  expectedStateVersion: bigint;
  executionMode: 'live' | 'sandbox';
  capabilities: readonly string[];
  toolNames: readonly string[];
}

export type ConversationTurnResult =
  | { status: 'completed'; content: string; rounds: number; toolCalls: number }
  | {
      status: 'handoff_required';
      reason: 'round_limit' | 'tool_limit';
      rounds: number;
      toolCalls: number;
    }
  | { status: 'skipped'; reason: 'already_running' | 'already_finished' }
  | { status: 'stale' }
  | { status: 'failed' };

export class ConversationTurnRejected extends Error {
  constructor() {
    super('Conversation turn rejected');
    this.name = 'ConversationTurnRejected';
  }
}

export class ConversationTurnCoordinator {
  constructor(
    private readonly context: AIContextBuilder,
    private readonly engine: ConversationEngine,
    private readonly ledger: AITurnLedger,
    private readonly tools: ToolRegistry,
    private readonly providerKey: string,
    private readonly modelKey: string,
  ) {}

  async run(request: ConversationTurnRequest): Promise<ConversationTurnResult> {
    this.validate(request);
    const begun = await this.ledger.begin({
      tenantId: request.tenantId,
      turnId: request.turnId,
      conversationId: request.conversationId,
      customerId: request.customerId,
      modeEpoch: request.expectedModeEpoch,
      stateVersion: request.expectedStateVersion,
    });
    if (begun !== 'started')
      return {
        status: 'skipped',
        reason: begun === 'running' ? 'already_running' : 'already_finished',
      };

    let result: ConversationEngineResult;
    try {
      const providerRequest = await this.context.build({
        tenantId: request.tenantId,
        conversationId: request.conversationId,
        customerId: request.customerId,
        executionMode: request.executionMode,
        tools: this.tools.definitions(request.toolNames),
      });
      result = await this.engine.run({ ...request, providerRequest });
    } catch (error) {
      if (error instanceof ConversationExecutionStale) {
        await this.ledger.finish({
          ...this.finishBase(request),
          outcome: 'stale',
          rounds: error.rounds,
          toolCalls: error.toolCalls,
          failureCode: 'conversation_stale',
          ...error.usage,
        });
        return { status: 'stale' };
      }
      await this.ledger.finish({
        ...this.finishBase(request),
        outcome: 'failed',
        rounds: 0,
        toolCalls: 0,
        failureCode:
          error instanceof AIContextUnavailable
            ? 'context_unavailable'
            : error instanceof AICompletionFailed
              ? 'provider_failed'
              : 'execution_failed',
        inputTokens: 0,
        outputTokens: 0,
      });
      return { status: 'failed' };
    }
    if (result.status === 'completed') {
      if (!result.content) return this.invalidResult(request);
      const committed = await this.complete(
        request,
        result,
        request.executionMode === 'live' ? result.content : undefined,
      );
      if (committed === 'stale') return { status: 'stale' };
      return {
        status: 'completed',
        content: result.content,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
      };
    }
    if (result.reason !== 'round_limit' && result.reason !== 'tool_limit')
      return this.invalidResult(request);
    await this.complete(request, result);
    return {
      status: 'handoff_required',
      reason: result.reason,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
    };
  }

  private complete(
    request: ConversationTurnRequest,
    result: ConversationEngineResult,
    deliveryText?: string,
  ) {
    return this.ledger.finish({
      ...this.finishBase(request),
      outcome: result.status,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      failureCode: null,
      ...(deliveryText === undefined ? {} : { deliveryText }),
      ...result.usage,
    });
  }

  private finishBase(request: ConversationTurnRequest) {
    return {
      tenantId: request.tenantId,
      turnId: request.turnId,
      providerKey: this.providerKey,
      modelKey: this.modelKey,
    };
  }

  private async invalidResult(request: ConversationTurnRequest): Promise<ConversationTurnResult> {
    await this.ledger.finish({
      ...this.finishBase(request),
      outcome: 'failed',
      rounds: 0,
      toolCalls: 0,
      failureCode: 'invalid_result',
      inputTokens: 0,
      outputTokens: 0,
    });
    return { status: 'failed' };
  }

  private validate(request: ConversationTurnRequest): void {
    if (
      ![
        request.tenantId,
        request.conversationId,
        request.customerId,
        request.correlationId,
        request.turnId,
      ].every((id) => isUUID(id)) ||
      request.expectedModeEpoch < 0n ||
      request.expectedStateVersion < 0n ||
      !['live', 'sandbox'].includes(request.executionMode) ||
      !Array.isArray(request.capabilities) ||
      !Array.isArray(request.toolNames)
    )
      throw new ConversationTurnRejected();
  }
}
