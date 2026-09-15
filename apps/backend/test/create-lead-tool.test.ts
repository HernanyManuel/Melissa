import assert from 'node:assert/strict';
import test from 'node:test';
import { LeadCreator, registerCreateLeadTool } from '../src/ai/create-lead-tool';
import { ToolExecutor } from '../src/ai/tool-executor';
import { ToolRegistry } from '../src/ai/tool-registry';

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
  expectedModeEpoch: 9n,
  executionMode: 'live' as const,
  capabilities: ['customer.lead.create'],
};

test('create_lead exposes a strict bounded schema and trusted scope', async () => {
  const calls: unknown[] = [];
  const creator: LeadCreator = {
    async create(input) {
      calls.push(input);
      return { status: 'created', duplicate: false };
    },
  };
  const registry = new ToolRegistry();
  registerCreateLeadTool(registry, creator);
  const definition = registry.definitions(['create_lead'])[0]!;
  assert.deepEqual(definition.inputSchema.required, ['topic', 'details']);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const result = await new ToolExecutor(registry).execute(
    [
      {
        id: 'lead_1',
        name: 'create_lead',
        arguments: { topic: '  Orçamento  ', details: '  Quer receber proposta amanhã.  ' },
      },
    ],
    context,
  );
  assert.equal(result[0]!.success, true);
  assert.deepEqual(calls, [
    {
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      customerId: context.customerId,
      turnId: context.turnId,
      expectedModeEpoch: 9n,
      idempotencyKey: `${context.turnId}:lead_1`,
      executionMode: 'live',
      topic: 'Orçamento',
      details: 'Quer receber proposta amanhã.',
    },
  ]);
});

test('create_lead rejects malformed input and missing capability', async () => {
  let executions = 0;
  const creator: LeadCreator = {
    async create() {
      executions += 1;
      return { status: 'created' };
    },
  };
  const registry = new ToolRegistry();
  registerCreateLeadTool(registry, creator);
  const executor = new ToolExecutor(registry);

  const result = await executor.execute(
    [
      { id: 'l1', name: 'create_lead', arguments: { topic: '', details: 'x' } },
      { id: 'l2', name: 'create_lead', arguments: { topic: 'x', details: '' } },
      {
        id: 'l3',
        name: 'create_lead',
        arguments: { topic: 'x', details: 'x', phone: '+351911111111' },
      },
    ],
    context,
  );
  assert.deepEqual(
    result.map((item) => item.error),
    ['invalid_arguments', 'invalid_arguments', 'invalid_arguments'],
  );
  const forbidden = await executor.execute(
    [{ id: 'l4', name: 'create_lead', arguments: { topic: 'x', details: 'y' } }],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
