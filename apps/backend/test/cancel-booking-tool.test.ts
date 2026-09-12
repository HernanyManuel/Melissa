import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingCanceller,
  CancelBookingRequest,
  registerCancelBookingTool,
} from '../src/ai/cancel-booking-tool';
import { ToolExecutor } from '../src/ai/tool-executor';
import { ToolRegistry } from '../src/ai/tool-registry';

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
  expectedModeEpoch: 17n,
  executionMode: 'live' as const,
  capabilities: ['booking.cancel'],
};

test('cancel_booking requires confirmation and injects trusted write scope', async () => {
  const calls: CancelBookingRequest[] = [];
  const canceller: BookingCanceller = {
    async cancel(input) {
      calls.push(input);
      return {
        status: 'cancelled',
        bookingId: input.bookingId,
        cancelledAt: '2026-09-17T08:00:00.000Z',
        duplicate: false,
        alreadyCancelled: false,
      };
    },
  };
  const registry = new ToolRegistry();
  registerCancelBookingTool(registry, canceller);
  const definition = registry.definitions(['cancel_booking'])[0]!;
  assert.deepEqual(definition.inputSchema.required, ['bookingId', 'expectedVersion', 'confirmed']);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const bookingId = '00000000-0000-4000-8000-000000000010';
  const result = await new ToolExecutor(registry).execute(
    [
      {
        id: 'cancel_1',
        name: 'cancel_booking',
        arguments: {
          bookingId,
          expectedVersion: 4,
          reason: 'Cliente pediu cancelamento',
          confirmed: true,
        },
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
      expectedModeEpoch: context.expectedModeEpoch,
      idempotencyKey: `${context.turnId}:cancel_1`,
      executionMode: 'live',
      bookingId,
      expectedVersion: 4,
      reason: 'Cliente pediu cancelamento',
      confirmed: true,
    },
  ]);
});

test('cancel_booking rejects unsafe arguments and missing capability before execution', async () => {
  let executions = 0;
  const canceller: BookingCanceller = {
    async cancel() {
      executions += 1;
      return { status: 'not_found' };
    },
  };
  const registry = new ToolRegistry();
  registerCancelBookingTool(registry, canceller);
  const executor = new ToolExecutor(registry);
  const bookingId = '00000000-0000-4000-8000-000000000010';

  const invalid = await executor.execute(
    [
      {
        id: 'c1',
        name: 'cancel_booking',
        arguments: { bookingId, expectedVersion: 1, confirmed: false },
      },
      {
        id: 'c2',
        name: 'cancel_booking',
        arguments: { bookingId: 'bad', expectedVersion: 1, confirmed: true },
      },
      {
        id: 'c3',
        name: 'cancel_booking',
        arguments: { bookingId, expectedVersion: 0, confirmed: true },
      },
      {
        id: 'c4',
        name: 'cancel_booking',
        arguments: {
          bookingId,
          expectedVersion: 1,
          confirmed: true,
          tenantId: context.tenantId,
        },
      },
      {
        id: 'c5',
        name: 'cancel_booking',
        arguments: { bookingId, expectedVersion: 1, confirmed: true, reason: '   ' },
      },
      {
        id: 'c6',
        name: 'cancel_booking',
        arguments: {
          bookingId,
          expectedVersion: 1,
          confirmed: true,
          reason: 'x'.repeat(501),
        },
      },
    ],
    context,
  );
  assert.deepEqual(
    invalid.map((item) => item.error),
    [
      'invalid_arguments',
      'invalid_arguments',
      'invalid_arguments',
      'invalid_arguments',
      'invalid_arguments',
      'invalid_arguments',
    ],
  );

  const forbidden = await executor.execute(
    [
      {
        id: 'c7',
        name: 'cancel_booking',
        arguments: { bookingId, expectedVersion: 1, confirmed: true },
      },
    ],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
