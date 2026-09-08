import assert from 'node:assert/strict';
import test from 'node:test';
import { AIGateway } from '../src/ai/ai-gateway';
import {
  ConversationEngine,
  ConversationExecutionStale,
  ConversationFence,
} from '../src/ai/conversation-engine';
import { AIProvider, AIProviderResponse } from '../src/ai/ai-provider';
import { ToolExecutor } from '../src/ai/tool-executor';
import { ToolRegistry } from '../src/ai/tool-registry';

const ids = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
};

const providerRequest = {
  systemPrompt: 'Use server tools.',
  messages: [{ role: 'user' as const, content: 'When do you open?' }],
  tools: [
    {
      name: 'get_business_hours',
      description: 'Read hours.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  maxOutputTokens: 512,
};

function scripted(responses: AIProviderResponse[], captured: unknown[] = []): AIProvider {
  let index = 0;
  return {
    providerKey: 'scripted',
    async complete(request) {
      captured.push(structuredClone(request));
      const response = responses[index++];
      if (!response) throw new Error('Unexpected provider round');
      return structuredClone(response);
    },
  };
}

function registry(executions: string[]): ToolRegistry {
  const result = new ToolRegistry();
  result.register({
    definition: providerRequest.tools[0]!,
    effect: 'read',
    requiredCapabilities: ['business.hours.read'],
    supportsIdempotency: false,
    validateArguments: (value) => value,
    execute: async (context) => {
      executions.push(context.idempotencyKey);
      return { opensAt: '09:00' };
    },
  });
  return result;
}

const activeFence: ConversationFence = { isCurrent: async () => true };
const request = {
  ...ids,
  expectedModeEpoch: 3n,
  executionMode: 'sandbox' as const,
  capabilities: ['business.hours.read'],
  providerRequest,
};

test('conversation engine performs a bounded tool round and returns accumulated usage', async () => {
  const captured: unknown[] = [];
  const executions: string[] = [];
  const provider = scripted(
    [
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'get_business_hours', arguments: {} }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      {
        content: 'We open at 09:00.',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 14, outputTokens: 5 },
      },
    ],
    captured,
  );
  const result = await new ConversationEngine(
    new AIGateway(provider),
    new ToolExecutor(registry(executions)),
    activeFence,
  ).run(request);
  assert.deepEqual(result, {
    status: 'completed',
    content: 'We open at 09:00.',
    reason: 'completed',
    rounds: 2,
    toolCalls: 1,
    usage: { inputTokens: 24, outputTokens: 7 },
  });
  assert.deepEqual(executions, [`${ids.turnId}:call_1`]);
  const second = captured[1] as { messages: Array<Record<string, unknown>> };
  assert.equal(second.messages.at(-2)?.role, 'tool_call');
  assert.deepEqual(second.messages.at(-1)?.result, {
    success: true,
    output: { opensAt: '09:00' },
  });
});

test('conversation engine checks fencing before tools and suppresses stale execution', async () => {
  let checks = 0;
  const executions: string[] = [];
  const fence: ConversationFence = { isCurrent: async () => ++checks < 3 };
  const provider = scripted([
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'get_business_hours', arguments: {} }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  await assert.rejects(
    new ConversationEngine(
      new AIGateway(provider),
      new ToolExecutor(registry(executions)),
      fence,
    ).run(request),
    ConversationExecutionStale,
  );
  assert.equal(executions.length, 0);
});

test('conversation engine requests handoff after round or tool budgets', async () => {
  const executions: string[] = [];
  const rounds = Array.from(
    { length: 4 },
    (_, index): AIProviderResponse => ({
      content: null,
      toolCalls: [{ id: `call_${index}`, name: 'get_business_hours', arguments: {} }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  const roundResult = await new ConversationEngine(
    new AIGateway(scripted(rounds)),
    new ToolExecutor(registry(executions)),
    activeFence,
  ).run(request);
  assert.equal(roundResult.reason, 'round_limit');
  assert.equal(roundResult.toolCalls, 4);

  const eightCalls = Array.from({ length: 8 }, (_, index) => ({
    id: `bulk_${index}`,
    name: 'get_business_hours',
    arguments: {},
  }));
  const toolResult = await new ConversationEngine(
    new AIGateway(
      scripted([
        {
          content: null,
          toolCalls: eightCalls,
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          content: null,
          toolCalls: [{ id: 'ninth', name: 'get_business_hours', arguments: {} }],
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]),
    ),
    new ToolExecutor(registry([])),
    activeFence,
  ).run(request);
  assert.equal(toolResult.reason, 'tool_limit');
  assert.equal(toolResult.toolCalls, 8);
});

test('conversation engine rejects malformed scope before provider access', async () => {
  const provider = scripted([]);
  await assert.rejects(
    new ConversationEngine(
      new AIGateway(provider),
      new ToolExecutor(registry([])),
      activeFence,
    ).run({ ...request, conversationId: 'invalid' }),
    ConversationExecutionStale,
  );
});
