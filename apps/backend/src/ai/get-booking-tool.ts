import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

export interface GetBookingRequest {
  tenantId: string;
  customerId: string;
  bookingId: string;
}

export interface BookingDetails {
  found: boolean;
  bookingId?: string;
  serviceId?: string;
  serviceName?: string;
  status?: string;
  source?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  staffId?: string | null;
  staffName?: string | null;
  durationMinutes?: number | null;
  amount?: string | null;
  currency?: string | null;
}

export interface BookingReader {
  getBooking(input: GetBookingRequest, signal: AbortSignal): Promise<BookingDetails>;
}

interface BookingRow {
  id: string;
  service_id: string;
  service_name: string;
  status: string;
  source: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  staff_id: string | null;
  staff_name: string | null;
  duration_minutes: number | null;
  price_snapshot: string | null;
  currency_snapshot: string | null;
}

export class PrismaBookingReader implements BookingReader {
  constructor(private readonly deps: Dependencies) {}

  async getBooking(input: GetBookingRequest, signal: AbortSignal): Promise<BookingDetails> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return this.deps.db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const rows = await tx.$queryRaw<BookingRow[]>`
        SELECT
          booking.id::text,
          booking.service_id::text,
          service.name AS service_name,
          booking.status,
          booking.source,
          booking.starts_at,
          booking.ends_at,
          COALESCE(booking.timezone, tenant.timezone) AS timezone,
          resource.staff_id::text,
          staff.name AS staff_name,
          booking.duration_minutes,
          booking.price_snapshot::text,
          booking.currency_snapshot
        FROM bookings booking
        JOIN tenants tenant ON tenant.id=booking.tenant_id
        JOIN services service
          ON service.tenant_id=booking.tenant_id AND service.id=booking.service_id
        JOIN booking_resources resource
          ON resource.tenant_id=booking.tenant_id AND resource.id=booking.resource_id
        LEFT JOIN staff
          ON staff.tenant_id=resource.tenant_id AND staff.id=resource.staff_id
        WHERE booking.tenant_id=${input.tenantId}::uuid
          AND booking.customer_id=${input.customerId}::uuid
          AND booking.id=${input.bookingId}::uuid
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return { found: false };
      return {
        found: true,
        bookingId: row.id,
        serviceId: row.service_id,
        serviceName: row.service_name,
        status: row.status,
        source: row.source,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        timezone: row.timezone,
        staffId: row.staff_id,
        staffName: row.staff_name,
        durationMinutes: row.duration_minutes,
        amount: row.price_snapshot,
        currency: row.currency_snapshot,
      };
    });
  }
}

function validateArguments(value: JsonObject): JsonObject {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.bookingId !== 'string' ||
    !isUUID(value.bookingId)
  )
    throw new Error('Invalid booking request');
  return { bookingId: value.bookingId };
}

function toJson(result: BookingDetails): JsonObject {
  if (!result.found) return { found: false };
  return {
    found: true,
    bookingId: result.bookingId!,
    serviceId: result.serviceId!,
    serviceName: result.serviceName!,
    status: result.status!,
    source: result.source!,
    startsAt: result.startsAt!,
    endsAt: result.endsAt!,
    timezone: result.timezone!,
    staffId: result.staffId ?? null,
    staffName: result.staffName ?? null,
    durationMinutes: result.durationMinutes ?? null,
    amount: result.amount ?? null,
    currency: result.currency ?? null,
  };
}

export function registerGetBookingTool(registry: ToolRegistry, reader: BookingReader): void {
  registry.register({
    definition: {
      name: 'get_booking',
      description:
        'Read one booking belonging to the current customer by bookingId. Never infer access from a supplied customer or tenant identifier.',
      inputSchema: {
        type: 'object',
        properties: { bookingId: { type: 'string', format: 'uuid' } },
        required: ['bookingId'],
        additionalProperties: false,
      },
    },
    effect: 'read',
    requiredCapabilities: ['booking.read'],
    supportsIdempotency: false,
    validateArguments,
    execute: async (context, arguments_, signal): Promise<JsonValue> =>
      toJson(
        await reader.getBooking(
          {
            tenantId: context.tenantId,
            customerId: context.customerId,
            bookingId: arguments_.bookingId as string,
          },
          signal,
        ),
      ),
  });
}
