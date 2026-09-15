import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomerUpdater, registerUpdateCustomerTool } from '../src/ai/update-customer-tool';
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
  capabilities: ['customer.profile.write'],
};

test('update_customer exposes strict single-field schema and trusted scope', async () => {
  const calls: unknown[] = [];
  const updater: CustomerUpdater = {
    async update(input) {
      calls.push(input);
      return { status: 'updated', duplicate: false };
    },
  };
  const registry = new ToolRegistry();
  registerUpdateCustomerTool(registry, updater);
  const definition = registry.definitions(['update_customer'])[0]!;
  assert.deepEqual(definition.inputSchema.required, ['field', 'value']);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const result = await new ToolExecutor(registry).execute(
    [
      {
        id: 'update_1',
        name: 'update_customer',
        arguments: { field: 'display_name', value: '  Ana Silva  ' },
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
      idempotencyKey: `${context.turnId}:update_1`,
      executionMode: 'live',
      patch: { displayName: 'Ana Silva' },
    },
  ]);
});

test('update_customer rejects forbidden fields, invalid values and missing capability', async () => {
  let executions = 0;
  const updater: CustomerUpdater = {
    async update() {
      executions += 1;
      return { status: 'updated' };
    },
  };
  const registry = new ToolRegistry();
  registerUpdateCustomerTool(registry, updater);
  const executor = new ToolExecutor(registry);

  const result = await executor.execute(
    [
      { id: 'u1', name: 'update_customer', arguments: { field: 'phone', value: '+351911111111' } },
      { id: 'u2', name: 'update_customer', arguments: { field: 'language', value: 'xx' } },
      { id: 'u3', name: 'update_customer', arguments: { field: 'email', value: 'not-an-email' } },
      { id: 'u4', name: 'update_customer', arguments: { field: 'display_name', value: null } },
    ],
    context,
  );
  assert.deepEqual(
    result.map((item) => item.error),
    ['invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'invalid_arguments'],
  );
  const forbidden = await executor.execute(
    [{ id: 'u5', name: 'update_customer', arguments: { field: 'language', value: 'en' } }],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
