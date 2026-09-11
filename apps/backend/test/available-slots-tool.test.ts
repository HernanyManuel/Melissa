import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingAvailabilityReader,
  registerAvailableSlotsTool,
} from '../src/ai/available-slots-tool';
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
  capabilities: ['booking.availability.read'],
};

test('get_available_slots exposes strict schema and injects trusted tenant scope', async () => {
  const calls: unknown[] = [];
  const reader: BookingAvailabilityReader = {
    async availableSlots(input) {
      calls.push(input);
      return {
        timezone: 'Europe/Lisbon',
        resourceId: '00000000-0000-4000-8000-000000000010',
        staffId: input.staffId ?? null,
        slots: [{ startsAt: '2026-09-15T08:00:00.000Z', endsAt: '2026-09-15T08:30:00.000Z' }],
      };
    },
  };
  const registry = new ToolRegistry();
  registerAvailableSlotsTool(registry, reader);
  const definition = registry.definitions(['get_available_slots'])[0]!;
  assert.deepEqual(definition.inputSchema.required, ['serviceId', 'date']);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const result = await new ToolExecutor(registry).execute(
    [
      {
        id: 'slots_1',
        name: 'get_available_slots',
        arguments: {
          serviceId: '00000000-0000-4000-8000-000000000020',
          date: '2026-09-15',
          staffId: '00000000-0000-4000-8000-000000000030',
        },
      },
    ],
    context,
  );
  assert.equal(result[0]!.success, true);
  assert.deepEqual(calls, [
    {
      tenantId: context.tenantId,
      serviceId: '00000000-0000-4000-8000-000000000020',
      date: '2026-09-15',
      staffId: '00000000-0000-4000-8000-000000000030',
    },
  ]);
});

test('get_available_slots rejects injected scope, impossible dates and missing capability', async () => {
  let executions = 0;
  const reader: BookingAvailabilityReader = {
    async availableSlots() {
      executions += 1;
      return {
        timezone: 'Europe/Lisbon',
        resourceId: '00000000-0000-4000-8000-000000000010',
        staffId: null,
        slots: [],
      };
    },
  };
  const registry = new ToolRegistry();
  registerAvailableSlotsTool(registry, reader);
  const executor = new ToolExecutor(registry);

  const result = await executor.execute(
    [
      {
        id: 's1',
        name: 'get_available_slots',
        arguments: {
          serviceId: '00000000-0000-4000-8000-000000000020',
          date: '2026-02-31',
        },
      },
      {
        id: 's2',
        name: 'get_available_slots',
        arguments: {
          serviceId: 'not-a-uuid',
          date: '2026-09-15',
        },
      },
      {
        id: 's3',
        name: 'get_available_slots',
        arguments: {
          serviceId: '00000000-0000-4000-8000-000000000020',
          date: '2026-09-15',
          tenantId: context.tenantId,
        },
      },
    ],
    context,
  );
  assert.deepEqual(
    result.map((item) => item.error),
    ['invalid_arguments', 'invalid_arguments', 'invalid_arguments'],
  );

  const forbidden = await executor.execute(
    [
      {
        id: 's4',
        name: 'get_available_slots',
        arguments: {
          serviceId: '00000000-0000-4000-8000-000000000020',
          date: '2026-09-15',
        },
      },
    ],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
