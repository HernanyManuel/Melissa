import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingDetails,
  BookingReader,
  GetBookingRequest,
  registerGetBookingTool,
} from '../src/ai/get-booking-tool';
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
  capabilities: ['booking.read'],
};

test('get_booking exposes only bookingId and injects tenant/customer scope', async () => {
  const calls: GetBookingRequest[] = [];
  const reader: BookingReader = {
    async getBooking(input): Promise<BookingDetails> {
      calls.push(input);
      return {
        found: true,
        bookingId: input.bookingId,
        serviceId: '00000000-0000-4000-8000-000000000020',
        serviceName: 'Corte',
        status: 'confirmed',
        source: 'ai',
        startsAt: '2026-09-15T08:00:00.000Z',
        endsAt: '2026-09-15T08:30:00.000Z',
        timezone: 'Europe/Lisbon',
        staffId: null,
        staffName: null,
        durationMinutes: 30,
        amount: '18.000000',
        currency: 'EUR',
      };
    },
  };
  const registry = new ToolRegistry();
  registerGetBookingTool(registry, reader);
  const definition = registry.definitions(['get_booking'])[0]!;
  assert.deepEqual(definition.inputSchema.required, ['bookingId']);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const bookingId = '00000000-0000-4000-8000-000000000010';
  const result = await new ToolExecutor(registry).execute(
    [{ id: 'read_1', name: 'get_booking', arguments: { bookingId } }],
    context,
  );
  assert.equal(result[0]!.success, true);
  assert.deepEqual(calls, [
    { tenantId: context.tenantId, customerId: context.customerId, bookingId },
  ]);
});

test('get_booking rejects injected scope, invalid IDs and missing capability', async () => {
  let executions = 0;
  const reader: BookingReader = {
    async getBooking() {
      executions += 1;
      return { found: false };
    },
  };
  const registry = new ToolRegistry();
  registerGetBookingTool(registry, reader);
  const executor = new ToolExecutor(registry);

  const result = await executor.execute(
    [
      { id: 'r1', name: 'get_booking', arguments: { bookingId: 'not-a-uuid' } },
      {
        id: 'r2',
        name: 'get_booking',
        arguments: {
          bookingId: '00000000-0000-4000-8000-000000000010',
          customerId: context.customerId,
        },
      },
    ],
    context,
  );
  assert.deepEqual(
    result.map((item) => item.error),
    ['invalid_arguments', 'invalid_arguments'],
  );

  const forbidden = await executor.execute(
    [
      {
        id: 'r3',
        name: 'get_booking',
        arguments: { bookingId: '00000000-0000-4000-8000-000000000010' },
      },
    ],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
