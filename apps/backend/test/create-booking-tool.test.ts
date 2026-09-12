import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateBookingRequest, CreateBookingResult } from '../src/booking/booking-engine';
import { BookingCreator, registerCreateBookingTool } from '../src/ai/create-booking-tool';
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
  capabilities: ['booking.create'],
};

test('create_booking exposes confirmation-gated schema and trusted scope', async () => {
  const calls: CreateBookingRequest[] = [];
  const creator: BookingCreator = {
    async createBooking(input): Promise<CreateBookingResult> {
      calls.push(input);
      return {
        status: 'created',
        bookingId: '00000000-0000-4000-8000-000000000010',
        startsAt: input.startsAt,
        endsAt: '2026-09-15T08:30:00.000Z',
        timezone: 'Europe/Lisbon',
        staffId: input.staffId ?? null,
        duplicate: false,
      };
    },
  };
  const registry = new ToolRegistry();
  registerCreateBookingTool(registry, creator);
  const definition = registry.definitions(['create_booking'])[0]!;
  assert.deepEqual(definition.inputSchema.required, ['serviceId', 'startsAt', 'confirmed']);
  assert.equal(definition.inputSchema.additionalProperties, false);

  const result = await new ToolExecutor(registry).execute(
    [
      {
        id: 'booking_1',
        name: 'create_booking',
        arguments: {
          serviceId: '00000000-0000-4000-8000-000000000020',
          startsAt: '2026-09-15T09:00:00+01:00',
          staffId: '00000000-0000-4000-8000-000000000030',
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
      idempotencyKey: `${context.turnId}:booking_1`,
      executionMode: 'live',
      serviceId: '00000000-0000-4000-8000-000000000020',
      startsAt: '2026-09-15T08:00:00.000Z',
      staffId: '00000000-0000-4000-8000-000000000030',
      confirmed: true,
    },
  ]);
});

test('create_booking returns structured creation policy denial as a successful tool result', async () => {
  const creator: BookingCreator = {
    async createBooking() {
      return {
        status: 'policy_denied',
        reason: 'maximum_horizon',
        minimumNoticeMinutes: 120,
        maximumHorizonDays: 30,
      } as const;
    },
  };
  const registry = new ToolRegistry();
  registerCreateBookingTool(registry, creator);

  const [result] = await new ToolExecutor(registry).execute(
    [
      {
        id: 'booking_policy',
        name: 'create_booking',
        arguments: {
          serviceId: '00000000-0000-4000-8000-000000000020',
          startsAt: '2026-10-15T08:00:00Z',
          confirmed: true,
        },
      },
    ],
    context,
  );
  assert.equal(result?.success, true);
  assert.deepEqual(result?.result, {
    status: 'policy_denied',
    reason: 'maximum_horizon',
    minimumNoticeMinutes: 120,
    maximumHorizonDays: 30,
  });
});

test('create_booking rejects missing confirmation, naive time, scope injection and missing capability', async () => {
  let executions = 0;
  const creator: BookingCreator = {
    async createBooking() {
      executions += 1;
      return { status: 'unavailable' } as const;
    },
  };
  const registry = new ToolRegistry();
  registerCreateBookingTool(registry, creator);
  const executor = new ToolExecutor(registry);
  const serviceId = '00000000-0000-4000-8000-000000000020';

  const result = await executor.execute(
    [
      {
        id: 'b1',
        name: 'create_booking',
        arguments: { serviceId, startsAt: '2026-09-15T08:00:00Z', confirmed: false },
      },
      {
        id: 'b2',
        name: 'create_booking',
        arguments: { serviceId, startsAt: '2026-09-15T09:00:00', confirmed: true },
      },
      {
        id: 'b3',
        name: 'create_booking',
        arguments: {
          serviceId,
          startsAt: '2026-09-15T08:00:00Z',
          confirmed: true,
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
        id: 'b4',
        name: 'create_booking',
        arguments: { serviceId, startsAt: '2026-09-15T08:00:00Z', confirmed: true },
      },
    ],
    { ...context, capabilities: [] },
  );
  assert.equal(forbidden[0]!.error, 'forbidden');
  assert.equal(executions, 0);
});
