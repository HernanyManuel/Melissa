import { isUUID } from 'class-validator';
import { AIGateway } from './ai-gateway';
import { AIInputItem, AIProviderRequest, JsonObject } from './ai-provider';
import { ToolExecutor, ToolTurnContext } from './tool-executor';

export interface ConversationFence {
  isCurrent(
    tenantId: string,
    conversationId: string,
    customerId: string,
    expectedModeEpoch: bigint,
  ): Promise<boolean>;
}

export interface ConversationEngineRequest extends ToolTurnContext {
  expectedModeEpoch: bigint;
  providerRequest: AIProviderRequest;
}

export interface ConversationEngineResult {
  status: 'completed' | 'handoff_required';
  content: string | null;
  reason: 'completed' | 'round_limit' | 'tool_limit';
  rounds: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
}

export class ConversationExecutionStale extends Error {
  constructor(
    readonly rounds = 0,
    readonly toolCalls = 0,
    readonly usage = { inputTokens: 0, outputTokens: 0 },
  ) {
    super('Conversation execution is stale');
    this.name = 'ConversationExecutionStale';
  }
}

export class ConversationEngine {
  constructor(
    private readonly gateway: AIGateway,
    private readonly tools: ToolExecutor,
    private readonly fence: ConversationFence,
  ) {}

  async run(request: ConversationEngineRequest): Promise<ConversationEngineResult> {
    if (
      ![
        request.tenantId,
        request.conversationId,
        request.customerId,
        request.correlationId,
        request.turnId,
      ].every((value) => isUUID(value)) ||
      request.expectedModeEpoch < 0n
    )
      throw new ConversationExecutionStale();
    const messages: AIInputItem[] = request.providerRequest.messages.map((message) =>
      structuredClone(message),
    );
    const usage = { inputTokens: 0, outputTokens: 0 };
    let totalToolCalls = 0;
    for (let round = 1; round <= 4; round++) {
      await this.assertCurrent(request, round - 1, totalToolCalls, usage);
      const response = await this.gateway.complete({
        tenantId: request.tenantId,
        correlationId: request.correlationId,
        systemPrompt: request.providerRequest.systemPrompt,
        messages,
        tools: request.providerRequest.tools,
        maxOutputTokens: request.providerRequest.maxOutputTokens,
      });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      await this.assertCurrent(request, round, totalToolCalls, usage);
      if (!response.toolCalls.length) {
        return {
          status: 'completed',
          content: response.content,
          reason: 'completed',
          rounds: round,
          toolCalls: totalToolCalls,
          usage,
        };
      }
      if (totalToolCalls + response.toolCalls.length > 8)
        return this.handoff('tool_limit', round, totalToolCalls, usage);
      for (const call of response.toolCalls) {
        await this.assertCurrent(request, round, totalToolCalls, usage);
        const [result] = await this.tools.execute([call], request);
        if (!result) throw new ConversationExecutionStale();
        totalToolCalls += 1;
        messages.push({
          role: 'tool_call',
          callId: call.id,
          name: call.name,
          arguments: structuredClone(call.arguments),
        });
        const payload: JsonObject = result.success
          ? { success: true, output: result.output ?? null }
          : { success: false, error: result.error ?? 'execution_failed' };
        messages.push({
          role: 'tool_result',
          callId: call.id,
          name: call.name,
          result: payload,
        });
      }
    }
    return this.handoff('round_limit', 4, totalToolCalls, usage);
  }

  private async assertCurrent(
    request: ConversationEngineRequest,
    rounds: number,
    toolCalls: number,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    if (
      !(await this.fence.isCurrent(
        request.tenantId,
        request.conversationId,
        request.customerId,
        request.expectedModeEpoch,
      ))
    )
      throw new ConversationExecutionStale(rounds, toolCalls, { ...usage });
  }

  private handoff(
    reason: 'round_limit' | 'tool_limit',
    rounds: number,
    toolCalls: number,
    usage: { inputTokens: number; outputTokens: number },
  ): ConversationEngineResult {
    return { status: 'handoff_required', content: null, reason, rounds, toolCalls, usage };
  }
}
