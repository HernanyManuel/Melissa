import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonObject } from '../src/ai/ai-provider';
import { ToolExecutionRejected, ToolExecutor } from '../src/ai/tool-executor';
import { ToolExecutionContext, ToolRegistry } from '../src/ai/tool-registry';

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
  executionMode: 'sandbox' as const,
  capabilities: ['business.hours.read'],
};

function registration(
  execute: (
    executionContext: Readonly<ToolExecutionContext>,
    arguments_: Readonly<JsonObject>,
    signal: AbortSignal,
  ) => Promise<JsonObject> = async (_executionContext, arguments_) => ({
    day: arguments_.day ?? null,
    opensAt: '09:00',
  }),
) {
  return {
    definition: {
      name: 'get_business_hours',
      description: 'Read configured business hours.',
      inputSchema: {
        type: 'object',
        properties: { day: { type: 'string' } },
        required: ['day'],
        additionalProperties: false,
      },
    },
    effect: 'read' as const,
    requiredCapabilities: ['business.hours.read'],
    supportsIdempotency: false,
    validateArguments(value: JsonObject): JsonObject {
      if (typeof value.day !== 'string' || Object.keys(value).length !== 1)
        throw new Error('invalid');
      return value;
    },
    execute,
  };
}

test('registry owns tool definitions and rejects unsafe registrations', () => {
  const registry = new ToolRegistry();
  const item = registration();
  registry.register(item);
  item.definition.description = 'caller mutation';
  assert.equal(
    registry.definitions(['get_business_hours'])[0]!.description.includes('configured'),
    true,
  );
  assert.throws(() => registry.register(registration()), /Invalid tool registration/);
  assert.throws(() =>
    new ToolRegistry().register({ ...registration(), effect: 'write', supportsIdempotency: false }),
  );
  const definitions = registry.definitions(['get_business_hours']);
  definitions[0]!.description = 'response mutation';
  assert.notEqual(
    registry.definitions(['get_business_hours'])[0]!.description,
    'response mutation',
  );
});

test('executor injects trusted scope and deterministic idempotency without exposing it as arguments', async () => {
  let capturedContext: Readonly<ToolExecutionContext> | undefined;
  let capturedArguments: Readonly<JsonObject> | undefined;
  const registry = new ToolRegistry();
  registry.register(
    registration(async (executionContext, arguments_) => {
      capturedContext = executionContext;
      capturedArguments = arguments_;
      return { opensAt: '09:00' };
    }),
  );
  const results = await new ToolExecutor(registry).execute(
    [{ id: 'call_1', name: 'get_business_hours', arguments: { day: 'monday' } }],
    context,
  );
  assert.deepEqual(results, [
    {
      callId: 'call_1',
      name: 'get_business_hours',
      success: true,
      output: { opensAt: '09:00' },
    },
  ]);
  assert.equal(capturedContext?.tenantId, context.tenantId);
  assert.equal(capturedContext?.customerId, context.customerId);
  assert.equal(capturedContext?.idempotencyKey, `${context.turnId}:call_1`);
  assert.deepEqual(capturedArguments, { day: 'monday' });
});

test('executor denies capabilities and bad arguments before invoking handlers', async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(
    registration(async () => {
      executions += 1;
      return {};
    }),
  );
  const executor = new ToolExecutor(registry);
  assert.equal(
    (
      await executor.execute(
        [{ id: 'call_1', name: 'get_business_hours', arguments: { day: 'monday' } }],
        { ...context, capabilities: [] },
      )
    )[0]!.error,
    'forbidden',
  );
  assert.equal(
    (
      await executor.execute(
        [{ id: 'call_2', name: 'get_business_hours', arguments: { unexpected: true } }],
        context,
      )
    )[0]!.error,
    'invalid_arguments',
  );
  assert.equal(executions, 0);
});

test('executor bounds calls, time and unsafe handler output with sanitized errors', async () => {
  const slow = new ToolRegistry();
  slow.register(
    registration(
      async () => new Promise<JsonObject>((resolve) => setTimeout(() => resolve({}), 500)),
    ),
  );
  const started = Date.now();
  const timeout = await new ToolExecutor(slow, 100).execute(
    [{ id: 'call_1', name: 'get_business_hours', arguments: { day: 'monday' } }],
    context,
  );
  assert.equal(timeout[0]!.error, 'timeout');
  assert(Date.now() - started < 400);

  const unsafe = new ToolRegistry();
  unsafe.register(registration(async () => JSON.parse('{"__proto__":{"admin":true}}')));
  assert.equal(
    (
      await new ToolExecutor(unsafe).execute(
        [{ id: 'call_2', name: 'get_business_hours', arguments: { day: 'monday' } }],
        context,
      )
    )[0]!.error,
    'execution_failed',
  );
  await assert.rejects(
    new ToolExecutor(unsafe).execute(
      Array.from({ length: 9 }, (_, index) => ({
        id: `call_${index}`,
        name: 'get_business_hours',
        arguments: { day: 'monday' },
      })),
      context,
    ),
    ToolExecutionRejected,
  );
});
