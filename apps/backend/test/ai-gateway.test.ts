import assert from 'node:assert/strict';
import test from 'node:test';
import { AIGateway, AIGatewayRequest } from '../src/ai/ai-gateway';
import { AICompletionFailed, AIProvider, AIProviderResponse } from '../src/ai/ai-provider';
import { MockAIProvider } from '../src/ai/mock-ai-provider';

const request: AIGatewayRequest = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  correlationId: '00000000-0000-4000-8000-000000000002',
  systemPrompt: 'Answer only from approved business context.',
  messages: [{ role: 'user', content: 'What time do you open?' }],
  tools: [
    {
      name: 'get_business_hours',
      description: 'Read configured opening hours.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};

test('AI gateway passes defensive provider input without tenant identifiers', async () => {
  let captured: object | undefined;
  const gateway = new AIGateway(
    new MockAIProvider((input) => {
      captured = input;
      input.messages[0]!.content = 'mutated by provider';
      return {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'get_business_hours', arguments: {} }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 12, outputTokens: 4 },
      };
    }),
  );
  const response = await gateway.complete(request);
  assert.equal(request.messages[0]!.content, 'What time do you open?');
  assert(captured);
  assert.equal('tenantId' in captured, false);
  assert.equal('correlationId' in captured, false);
  assert.equal(response.toolCalls[0]!.name, 'get_business_hours');
});

test('AI gateway rejects unregistered, duplicate and malformed tool calls', async () => {
  const invalid: AIProviderResponse[] = [
    {
      content: null,
      toolCalls: [{ id: 'call_1', name: 'delete_database', arguments: {} }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      content: null,
      toolCalls: [
        { id: 'same', name: 'get_business_hours', arguments: {} },
        { id: 'same', name: 'get_business_hours', arguments: {} },
      ],
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      content: 'text',
      toolCalls: [],
      finishReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      content: null,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
  for (const response of invalid)
    await assert.rejects(
      new AIGateway(new MockAIProvider(() => response)).complete(request),
      AICompletionFailed,
    );
});

test('AI gateway enforces request, schema, output and JSON safety limits', async () => {
  const gateway = new AIGateway(new MockAIProvider());
  for (const invalid of [
    { ...request, tenantId: 'invalid' },
    { ...request, correlationId: 'invalid' },
    { ...request, systemPrompt: '' },
    { ...request, messages: [{ role: 'user' as const, content: 'x'.repeat(4001) }] },
    { ...request, maxOutputTokens: 0 },
    { ...request, tools: [{ ...request.tools[0]!, name: 'Invalid-Name' }] },
    { ...request, tools: [request.tools[0]!, request.tools[0]!] },
  ])
    await assert.rejects(gateway.complete(invalid), AICompletionFailed);
  const polluted = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, never>;
  await assert.rejects(
    new AIGateway(
      new MockAIProvider(() => ({
        content: null,
        toolCalls: [{ id: 'call', name: 'get_business_hours', arguments: polluted }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    ).complete(request),
    AICompletionFailed,
  );
});

test('AI gateway sanitizes provider failures and accepts a bounded text answer', async () => {
  const broken: AIProvider = {
    providerKey: 'broken',
    complete: async () => {
      throw new Error('secret provider detail');
    },
  };
  await assert.rejects(new AIGateway(broken).complete(request), (error: unknown) => {
    assert(error instanceof AICompletionFailed);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  const response = await new AIGateway(new MockAIProvider()).complete(request);
  assert.equal(response.content, 'Mock response');
  response.content = 'caller mutation';
  assert.equal(
    (await new AIGateway(new MockAIProvider()).complete(request)).content,
    'Mock response',
  );
});
