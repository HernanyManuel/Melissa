import { isUUID } from 'class-validator';
import { AvailabilityRequest, AvailabilityResult } from '../booking/booking-engine';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

export interface BookingAvailabilityReader {
  availableSlots(input: AvailabilityRequest, signal: AbortSignal): Promise<AvailabilityResult>;
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid booking date');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error('Invalid booking date');
}

function validateArguments(value: JsonObject): JsonObject {
  const keys = Object.keys(value);
  if (keys.length < 2 || keys.length > 3) throw new Error('Invalid availability request');
  if (typeof value.serviceId !== 'string' || !isUUID(value.serviceId))
    throw new Error('Invalid service ID');
  if (typeof value.date !== 'string') throw new Error('Invalid booking date');
  validateDate(value.date);
  if (value.staffId !== undefined && (typeof value.staffId !== 'string' || !isUUID(value.staffId)))
    throw new Error('Invalid staff ID');
  for (const key of keys) {
    if (!['serviceId', 'date', 'staffId'].includes(key))
      throw new Error('Invalid availability request');
  }
  return value.staffId === undefined
    ? { serviceId: value.serviceId, date: value.date }
    : { serviceId: value.serviceId, date: value.date, staffId: value.staffId };
}

export function registerAvailableSlotsTool(
  registry: ToolRegistry,
  reader: BookingAvailabilityReader,
): void {
  registry.register({
    definition: {
      name: 'get_available_slots',
      description:
        'Get available booking slots for one active service and local calendar date. Availability is not a reservation.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', format: 'uuid' },
          date: { type: 'string', format: 'date' },
          staffId: { type: 'string', format: 'uuid' },
        },
        required: ['serviceId', 'date'],
        additionalProperties: false,
      },
    },
    effect: 'read',
    requiredCapabilities: ['booking.availability.read'],
    supportsIdempotency: false,
    validateArguments,
    execute: (context, arguments_, signal): Promise<JsonValue> =>
      reader.availableSlots(
        {
          tenantId: context.tenantId,
          serviceId: arguments_.serviceId as string,
          date: arguments_.date as string,
          ...(arguments_.staffId === undefined ? {} : { staffId: arguments_.staffId as string }),
        },
        signal,
      ),
  });
}
