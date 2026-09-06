import assert from 'node:assert/strict';
import test from 'node:test';
import { createAIProvider } from '../src/ai/ai-provider-factory';
import { AIProviderRequest } from '../src/ai/ai-provider';
import { MockAIProvider } from '../src/ai/mock-ai-provider';
import { OpenAIResponsesProvider } from '../src/ai/openai-responses-provider';
import { parseConfig } from '../src/config';

const providerRequest: AIProviderRequest = {
  systemPrompt: 'Use approved context only.',
  messages: [{ role: 'user', content: 'When are you open?' }],
  tools: [
    {
      name: 'get_business_hours',
      description: 'Read business hours.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
  maxOutputTokens: 512,
};

function provider(
  payload: unknown,
  inspect?: (url: string | URL | Request, init?: RequestInit) => void,
  status = 200,
): OpenAIResponsesProvider {
  return new OpenAIResponsesProvider({
    apiKey: 'sk-test-not-a-real-secret-value',
    model: 'test-model',
    fetcher: (async (url, init) => {
      inspect?.(url, init);
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}

test('OpenAI adapter sends a non-stored bounded Responses API request', async () => {
  let body: Record<string, unknown> | undefined;
  const result = await provider(
    {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'We open at nine.' }] }],
      usage: { input_tokens: 21, output_tokens: 6 },
    },
    (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(
        (init?.headers as Record<string, string> | undefined)?.authorization?.includes(
          'not-a-real',
        ),
        true,
      );
    },
  ).complete(providerRequest);
  assert.deepEqual(result, {
    content: 'We open at nine.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 21, outputTokens: 6 },
  });
  assert(body);
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_output_tokens, 512);
  assert.equal(JSON.stringify(body).includes('tenantId'), false);
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]!.strict, true);
  assert.deepEqual(tools[0]!.parameters, providerRequest.tools[0]!.inputSchema);
});

test('OpenAI adapter parses function calls without executing them', async () => {
  const result = await provider({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'get_business_hours',
        arguments: '{"day":"monday"}',
      },
    ],
    usage: { input_tokens: 10, output_tokens: 3 },
  }).complete(providerRequest);
  assert.deepEqual(result.toolCalls, [
    { id: 'call_123', name: 'get_business_hours', arguments: { day: 'monday' } },
  ]);
  assert.equal(result.content, null);
  assert.equal(result.finishReason, 'tool_calls');
});

test('OpenAI adapter fails closed on transport and malformed outputs', async () => {
  await assert.rejects(
    provider({ error: { message: 'sensitive' } }, undefined, 429).complete(providerRequest),
  );
  for (const payload of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [] },
    {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
    },
    {
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call', name: 'get_business_hours', arguments: '[]' },
      ],
    },
  ])
    await assert.rejects(provider(payload).complete(providerRequest));
});

test('AI provider selection is explicit and never silently falls back', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  };
  assert.equal(createAIProvider(parseConfig(base)), null);
  assert(createAIProvider(parseConfig({ ...base, AI_PROVIDER: 'mock' })) instanceof MockAIProvider);
  assert.throws(() => parseConfig({ ...base, AI_PROVIDER: 'openai' }), /requires a server-side/);
  assert.throws(() => parseConfig({ ...base, OPENAI_API_KEY: 'sk-test-not-a-real-secret-value' }));
  const config = parseConfig({
    ...base,
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-secret-value',
    OPENAI_MODEL: 'test-model',
  });
  assert(createAIProvider(config) instanceof OpenAIResponsesProvider);
});
