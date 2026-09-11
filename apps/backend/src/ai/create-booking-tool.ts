import { isUUID } from 'class-validator';
import {
  CreateBookingRequest,
  CreateBookingResult,
} from '../booking/booking-engine';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

export interface BookingCreator {
  createBooking(input: CreateBookingRequest, signal: AbortSignal): Promise<CreateBookingResult>;
}

function validateInstant(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Booking time requires an offset');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid booking time');
  return parsed.toISOString();
}

function validateArguments(value: JsonObject): JsonObject {
  const keys = Object.keys(value);
  if (keys.length < 3 || keys.length > 4) throw new Error('Invalid booking request');
  if (typeof value.serviceId !== 'string' || !isUUID(value.serviceId))
    throw new Error('Invalid service ID');
  if (typeof value.startsAt !== 'string') throw new Error('Invalid booking time');
  if (value.confirmed !== true) throw new Error('Booking requires explicit confirmation');
  if (value.staffId !== undefined && (typeof value.staffId !== 'string' || !isUUID(value.staffId)))
    throw new Error('Invalid staff ID');
  for (const key of keys) {
    if (!['serviceId', 'startsAt', 'staffId', 'confirmed'].includes(key))
      throw new Error('Invalid booking request');
  }
  const startsAt = validateInstant(value.startsAt);
  return value.staffId === undefined
    ? { serviceId: value.serviceId, startsAt, confirmed: true }
    : { serviceId: value.serviceId, startsAt, staffId: value.staffId, confirmed: true };
}

function toJson(result: CreateBookingResult): JsonObject {
  if (result.status === 'unavailable') return { status: 'unavailable' };
  return {
    status: result.status,
    bookingId: result.bookingId,
    startsAt: result.startsAt,
    endsAt: result.endsAt,
    timezone: result.timezone,
    staffId: result.staffId,
    duplicate: result.duplicate,
  };
}

export function registerCreateBookingTool(registry: ToolRegistry, creator: BookingCreator): void {
  registry.register({
    definition: {
      name: 'create_booking',
      description:
        'Create a booking only after the customer explicitly confirms the exact service and slot. Use an exact startsAt returned by availability; never substitute another time or staff member.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', format: 'uuid' },
          startsAt: { type: 'string', format: 'date-time' },
          staffId: { type: 'string', format: 'uuid' },
          confirmed: { type: 'boolean', enum: [true] },
        },
        required: ['serviceId', 'startsAt', 'confirmed'],
        additionalProperties: false,
      },
    },
    effect: 'write',
    requiredCapabilities: ['booking.create'],
    supportsIdempotency: true,
    validateArguments,
    execute: async (context, arguments_, signal): Promise<JsonValue> =>
      toJson(
        await creator.createBooking(
          {
            tenantId: context.tenantId,
            conversationId: context.conversationId,
            customerId: context.customerId,
            turnId: context.turnId,
            expectedModeEpoch: context.expectedModeEpoch,
            idempotencyKey: context.idempotencyKey,
            executionMode: context.executionMode,
            serviceId: arguments_.serviceId as string,
            startsAt: arguments_.startsAt as string,
            ...(arguments_.staffId === undefined
              ? {}
              : { staffId: arguments_.staffId as string }),
            confirmed: true,
          },
          signal,
        ),
      ),
  });
}
