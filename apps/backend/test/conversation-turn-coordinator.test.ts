import assert from 'node:assert/strict';
import test from 'node:test';
import { AIContextBuilder } from '../src/ai/ai-context-builder';
import { AIGateway } from '../src/ai/ai-gateway';
import { AIProvider } from '../src/ai/ai-provider';
import { AITurnFinish, AITurnLedger, AITurnLedgerRepository } from '../src/ai/ai-turn-ledger';
import { ConversationEngine, ConversationFence } from '../src/ai/conversation-engine';
import { ConversationTurnCoordinator } from '../src/ai/conversation-turn-coordinator';
import { ToolExecutor } from '../src/ai/tool-executor';
import { ToolRegistry } from '../src/ai/tool-registry';

const ids = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
};
const request = {
  ...ids,
  expectedModeEpoch: 2n,
  expectedStateVersion: 4n,
  executionMode: 'live' as const,
  capabilities: ['business.info.read'],
  toolNames: ['get_business_info'],
};

function context(): AIContextBuilder {
  return new AIContextBuilder({
    load: async () => ({
      business: {
        name: 'Barbearia Central',
        city: null,
        address: null,
        website: null,
        timezone: 'Europe/Lisbon',
        locale: 'pt',
        currency: 'EUR',
      },
      preferences: null,
      policies: null,
      faqs: [],
      services: [],
      customer: { displayName: 'Cliente', language: 'pt' },
      conversation: {
        mode: 'AI_ACTIVE',
        language: 'pt',
        messages: [{ role: 'user', content: 'Olá' }],
      },
    }),
  });
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: 'get_business_info',
      description: 'Read public business information.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    effect: 'read',
    requiredCapabilities: ['business.info.read'],
    supportsIdempotency: false,
    validateArguments: (value) => value,
    execute: async () => ({ name: 'Barbearia Central' }),
  });
  return tools;
}

function setup(
  provider: AIProvider,
  fence: ConversationFence = { isCurrent: async () => true },
  begin: Awaited<ReturnType<AITurnLedgerRepository['begin']>> = 'started',
  finishResult: Awaited<ReturnType<AITurnLedgerRepository['finish']>> = 'finished',
) {
  const finishes: AITurnFinish[] = [];
  const repository: AITurnLedgerRepository = {
    begin: async () => begin,
    finish: async (input) => {
      finishes.push(input);
      return finishResult;
    },
  };
  const tools = registry();
  const coordinator = new ConversationTurnCoordinator(
    context(),
    new ConversationEngine(new AIGateway(provider), new ToolExecutor(tools), fence),
    new AITurnLedger(repository),
    tools,
    provider.providerKey,
    'configured-model',
  );
  return { coordinator, finishes };
}

test('turn coordinator records completion usage before returning content', async () => {
  const { coordinator, finishes } = setup({
    providerKey: 'mock',
    complete: async () => ({
      content: 'Olá, como posso ajudar?',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 6 },
    }),
  });
  assert.deepEqual(await coordinator.run(request), {
    status: 'completed',
    content: 'Olá, como posso ajudar?',
    rounds: 1,
    toolCalls: 0,
  });
  assert.deepEqual(finishes, [
    {
      tenantId: ids.tenantId,
      turnId: ids.turnId,
      providerKey: 'mock',
      modelKey: 'configured-model',
      outcome: 'completed',
      rounds: 1,
      toolCalls: 0,
      failureCode: null,
      inputTokens: 12,
      outputTokens: 6,
      deliveryText: 'Olá, como posso ajudar?',
    },
  ]);
});

test('turn coordinator suppresses duplicate delivery before context or provider access', async () => {
  let calls = 0;
  const { coordinator, finishes } = setup(
    {
      providerKey: 'mock',
      complete: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    },
    undefined,
    {
      conversationId: ids.conversationId,
      customerId: ids.customerId,
      modeEpoch: 2n,
      stateVersion: 4n,
      status: 'completed',
    },
  );
  assert.deepEqual(await coordinator.run(request), {
    status: 'skipped',
    reason: 'already_finished',
  });
  assert.equal(calls, 0);
  assert.equal(finishes.length, 0);
});

test('turn coordinator preserves consumed usage when fencing becomes stale', async () => {
  let checks = 0;
  const { coordinator, finishes } = setup(
    {
      providerKey: 'mock',
      complete: async () => ({
        content: 'Resposta obsoleta',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 9, outputTokens: 4 },
      }),
    },
    { isCurrent: async () => ++checks === 1 },
  );
  assert.deepEqual(await coordinator.run(request), { status: 'stale' });
  assert.equal(finishes[0]?.outcome, 'stale');
  assert.equal(finishes[0]?.failureCode, 'conversation_stale');
  assert.equal(finishes[0]?.inputTokens, 9);
  assert.equal(finishes[0]?.outputTokens, 4);
});

test('final transactional fence suppresses content after a concurrent takeover', async () => {
  const { coordinator, finishes } = setup(
    {
      providerKey: 'mock',
      complete: async () => ({
        content: 'Não pode ser enviada',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 3 },
      }),
    },
    undefined,
    'started',
    'stale',
  );
  assert.deepEqual(await coordinator.run(request), { status: 'stale' });
  assert.equal(finishes[0]?.deliveryText, 'Não pode ser enviada');
});

test('turn coordinator closes provider failures with sanitized zero-known usage', async () => {
  const { coordinator, finishes } = setup({
    providerKey: 'mock',
    complete: async () => {
      throw new Error('secret upstream detail');
    },
  });
  assert.deepEqual(await coordinator.run(request), { status: 'failed' });
  assert.equal(finishes[0]?.failureCode, 'provider_failed');
  assert.equal(finishes[0]?.inputTokens, 0);
  assert.equal(JSON.stringify(finishes).includes('secret upstream detail'), false);
});
