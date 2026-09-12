import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingRescheduler,
  RescheduleBookingRequest,
  registerRescheduleBookingTool,
} from '../src/ai/reschedule-booking-tool';
import { ToolExecutor } from '../src/ai/tool-executor';
import { ToolRegistry } from '../src/ai/tool-registry';

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  turnId: '00000000-0000-4000-8000-000000000005',
  expectedModeEpoch: 19n,
  executionMode: 'live' as const,
  capabilities: ['booking.reschedule'],
};

test('reschedule_booking exposes booking, version, time and confirmation with trusted scope', async () => {
  const calls: RescheduleBookingRequest[] = [];
  const rescheduler: BookingRescheduler = {
    async reschedule(input) {
      calls.push(input);
      return {
        status: 'rescheduled',
        bookingId: input.bookingId,
        startsAt: input.startsAt,
        endsAt: '2026-09-18T10:30:00.000Z',
        timezone: 'Europe/Lisbon',
        duplicate: false,
      };
    },
  };
  const registry = new ToolRegistry();
  registerRescheduleBookingTool(registry, rescheduler);
  const definition = registry.definitions(['reschedule_booking'])[0]!;
  assert.deepEqual(definition.inputSchema.required, [
    'bookingId',
    'expectedVersion',
    'startsAt',
    'confirmed',
  ]);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const bookingId = '00000000-0000-4000-8000-000000000010';
  const result = await new ToolExecutor(registry).execute(
    [
      {
        id: 'reschedule_1',
        name: 'reschedule_booking',
        arguments: {
          bookingId,
          expectedVersion: 3,
          startsAt: '2026-09-18T11:00:00+01:00',
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
      idempotencyKey: `${context.turnId}:reschedule_1`,
      executionMode: 'live',
      bookingId,
      expectedVersion: 3,
      startsAt: '2026-09-18T10:00:00.000Z',
      confirmed: true,
    },
  ]);
});

test('reschedule_booking rejects unsafe arguments, stale preconditions, naive time and missing capability', async () => {
  let executions = 0;
  const rescheduler: BookingRescheduler = {
    async reschedule() {
      executions += 1;
      return { status: 'not_found' };
    },
  };
  const registry = new ToolRegistry();
  registerRescheduleBookingTool(registry, rescheduler);
  const executor = new ToolExecutor(registry);
  const bookingId = '00000000-0000-4000-8000-000000000010';

  const invalid = await executor.execute(
    [
      {
        id: 'r1',
        name: 'reschedule_booking',
        arguments: {
          bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-18T10:00:00Z',
          confirmed: false,
        },
      },
      {
        id: 'r2',
        name: 'reschedule_booking',
        arguments: {
          bookingId: 'bad',
          expectedVersion: 1,
          startsAt: '2026-09-18T10:00:00Z',
          confirmed: true,
        },
      },
      {
        id: 'r3',
        name: 'reschedule_booking',
        arguments: {
          bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-18T10:00:00',
          confirmed: true,
        },
      },
      {
        id: 'r4',
        name: 'reschedule_booking',
        arguments: {
          bookingId,
          expectedVersion: 0,
          startsAt: '2026-09-18T10:00:00Z',
          confirmed: true,
        },
      },
      {
        id: 'r5',
        name: 'reschedule_booking',
        arguments: {
          bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-18T10:00:00Z',
          confirmed: true,
          tenantId: context.tenantId,
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
    ],
  );

  const forbidden = await executor.execute(
    [
      {
        id: 'r6',
        name: 'reschedule_booking',
        arguments: {
          bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-18T10:00:00Z',
          confirmed: true,
        },
      },
    ],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
