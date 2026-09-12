import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

export interface RescheduleBookingRequest {
  tenantId: string;
  conversationId: string;
  customerId: string;
  turnId: string;
  expectedModeEpoch: bigint;
  idempotencyKey: string;
  executionMode: 'live' | 'sandbox';
  bookingId: string;
  expectedVersion: number;
  startsAt: string;
  confirmed: true;
}

export type RescheduleBookingResult =
  | {
      status: 'rescheduled';
      bookingId: string;
      startsAt: string;
      endsAt: string;
      timezone: string;
      duplicate: boolean;
    }
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | { status: 'stale' };

export interface BookingRescheduler {
  reschedule(
    input: RescheduleBookingRequest,
    signal: AbortSignal,
  ): Promise<RescheduleBookingResult>;
}

interface ExistingOperation {
  booking_id: string;
  conversation_id: string;
  customer_id: string;
  turn_id: string;
  operation: string;
  arguments_hash: string;
  result_starts_at: Date | null;
  result_ends_at: Date | null;
  result_timezone: string | null;
}

interface BookingRow {
  id: string;
  version: number;
  status: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  timezone: string | null;
}

interface Period {
  start_time: string;
  end_time: string;
}

function validateInstant(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Booking time requires an offset');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid booking time');
  return parsed.toISOString();
}

function validateArguments(value: JsonObject): JsonObject {
  const keys = Object.keys(value);
  if (keys.length !== 4) throw new Error('Invalid reschedule request');
  if (typeof value.bookingId !== 'string' || !isUUID(value.bookingId))
    throw new Error('Invalid booking ID');
  if (
    typeof value.expectedVersion !== 'number' ||
    !Number.isInteger(value.expectedVersion) ||
    value.expectedVersion < 1
  )
    throw new Error('Invalid booking version');
  if (typeof value.startsAt !== 'string') throw new Error('Invalid booking time');
  if (value.confirmed !== true) throw new Error('Reschedule requires explicit confirmation');
  for (const key of keys) {
    if (!['bookingId', 'expectedVersion', 'startsAt', 'confirmed'].includes(key))
      throw new Error('Invalid reschedule request');
  }
  return {
    bookingId: value.bookingId,
    expectedVersion: value.expectedVersion,
    startsAt: validateInstant(value.startsAt),
    confirmed: true,
  };
}

function argumentsHash(input: RescheduleBookingRequest, startsAt: Date): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        bookingId: input.bookingId,
        expectedVersion: input.expectedVersion,
        startsAt: startsAt.toISOString(),
        confirmed: true,
      }),
    )
    .digest('hex');
}

function toJson(result: RescheduleBookingResult): JsonObject {
  if (result.status === 'not_found' || result.status === 'unavailable' || result.status === 'stale')
    return { status: result.status };
  return {
    status: result.status,
    bookingId: result.bookingId,
    startsAt: result.startsAt,
    endsAt: result.endsAt,
    timezone: result.timezone,
    duplicate: result.duplicate,
  };
}

function isExclusionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2010') return false;
  const code = error.meta?.code;
  return code === '23P01';
}

export class PrismaBookingRescheduler implements BookingRescheduler {
  constructor(private readonly deps: Dependencies) {}

  async reschedule(
    input: RescheduleBookingRequest,
    signal: AbortSignal,
  ): Promise<RescheduleBookingResult> {
    if (input.executionMode !== 'live') throw new Error('Booking reschedule is live-only');
    if (input.confirmed !== true) throw new Error('Reschedule requires explicit confirmation');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const startsAt = new Date(validateInstant(input.startsAt));
    const hash = argumentsHash(input, startsAt);

    try {
      return await this.deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;

        const replay = await tx.$queryRaw<ExistingOperation[]>`
          SELECT booking_id::text, conversation_id::text, customer_id::text, turn_id::text,
            operation, arguments_hash, result_starts_at, result_ends_at, result_timezone
          FROM booking_operations
          WHERE tenant_id=${input.tenantId}::uuid AND idempotency_key=${input.idempotencyKey}
          LIMIT 1
        `;
        if (replay.length) {
          const row = replay[0]!;
          if (
            row.booking_id !== input.bookingId ||
            row.conversation_id !== input.conversationId ||
            row.customer_id !== input.customerId ||
            row.turn_id !== input.turnId ||
            row.operation !== 'reschedule' ||
            row.arguments_hash !== hash
          )
            throw new Error('Idempotency conflict');
          if (!row.result_starts_at || !row.result_ends_at || !row.result_timezone) {
            throw new Error('Reschedule replay is inconsistent');
          }
          return {
            status: 'rescheduled',
            bookingId: row.booking_id,
            startsAt: row.result_starts_at.toISOString(),
            endsAt: row.result_ends_at.toISOString(),
            timezone: row.result_timezone,
            duplicate: true,
          };
        }

        const conversations = await tx.$queryRaw<Array<{ mode: string; mode_epoch: bigint }>>`
          SELECT mode, mode_epoch
          FROM conversations
          WHERE tenant_id=${input.tenantId}::uuid
            AND id=${input.conversationId}::uuid
            AND customer_id=${input.customerId}::uuid
          FOR UPDATE
        `;
        const conversation = conversations[0];
        if (
          conversation?.mode !== 'AI_ACTIVE' ||
          conversation.mode_epoch !== input.expectedModeEpoch
        )
          throw new Error('Booking reschedule is stale');
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const bookings = await tx.$queryRaw<BookingRow[]>`
          SELECT id::text, version, status, resource_id::text, starts_at, ends_at,
            buffer_before_minutes, buffer_after_minutes, timezone
          FROM bookings
          WHERE tenant_id=${input.tenantId}::uuid AND id=${input.bookingId}::uuid
            AND customer_id=${input.customerId}::uuid
          FOR UPDATE
        `;
        const booking = bookings[0];
        if (!booking) return { status: 'not_found' };
        if (booking.version !== input.expectedVersion) return { status: 'stale' };
        if (booking.status === 'cancelled') return { status: 'unavailable' };
        if (booking.starts_at.getTime() === startsAt.getTime()) return { status: 'unavailable' };

        const resources = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text
          FROM booking_resources
          WHERE tenant_id=${input.tenantId}::uuid
            AND id=${booking.resource_id}::uuid
            AND active=true
          FOR UPDATE
        `;
        if (!resources.length) return { status: 'unavailable' };

        const durationMs = booking.ends_at.getTime() - booking.starts_at.getTime();
        if (durationMs <= 0 || durationMs % 60_000 !== 0) return { status: 'unavailable' };
        const durationMinutes = durationMs / 60_000;
        const timezone = await this.resolveTimezone(tx, input.tenantId, booking.timezone);
        const [local] = await tx.$queryRaw<Array<{ local_date: string }>>`
          SELECT to_char(${startsAt}::timestamptz AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS local_date
        `;
        if (!local) return { status: 'unavailable' };
        const periods = await this.periods(tx, input.tenantId, local.local_date);
        if (
          !(await this.isCandidateInPeriods(
            tx,
            startsAt,
            local.local_date,
            periods,
            timezone,
            durationMinutes,
          ))
        )
          return { status: 'unavailable' };

        const endsAt = new Date(startsAt.getTime() + durationMs);
        const updated = await tx.$executeRaw`
          UPDATE bookings
          SET starts_at=${startsAt}, ends_at=${endsAt}, version=version+1, updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=${input.tenantId}::uuid AND id=${input.bookingId}::uuid
            AND customer_id=${input.customerId}::uuid AND version=${input.expectedVersion}
        `;
        if (updated !== 1) return { status: 'stale' };

        const operations = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO booking_operations (
            tenant_id, booking_id, conversation_id, customer_id, turn_id,
            idempotency_key, operation, arguments_hash,
            result_starts_at, result_ends_at, result_timezone
          ) VALUES (
            ${input.tenantId}::uuid, ${input.bookingId}::uuid, ${input.conversationId}::uuid,
            ${input.customerId}::uuid, ${input.turnId}::uuid, ${input.idempotencyKey},
            'reschedule', ${hash}, ${startsAt}, ${endsAt}, ${timezone}
          )
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
          RETURNING id::text
        `;
        if (!operations.length) throw new Error('Reschedule operation conflict');

        await tx.$executeRaw`
          INSERT INTO booking_outbox (tenant_id, booking_id, event_type)
          VALUES (${input.tenantId}::uuid, ${input.bookingId}::uuid, 'rescheduled')
        `;
        await tx.auditEvent.create({
          data: {
            id: randomUUID(),
            tenantId: input.tenantId,
            actorId: null,
            actorType: 'system',
            action: 'ai.booking_rescheduled',
            targetId: input.bookingId,
          },
        });

        return {
          status: 'rescheduled',
          bookingId: input.bookingId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          timezone,
          duplicate: false,
        };
      });
    } catch (error) {
      if (isExclusionConflict(error)) return { status: 'unavailable' };
      throw error;
    }
  }

  private async resolveTimezone(
    tx: Prisma.TransactionClient,
    tenantId: string,
    snapshot: string | null,
  ): Promise<string> {
    if (snapshot) return snapshot;
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    if (!tenant) throw new Error('Booking tenant is unavailable');
    return tenant.timezone;
  }

  private async periods(
    tx: Prisma.TransactionClient,
    tenantId: string,
    date: string,
  ): Promise<Period[]> {
    const [exception] = await tx.$queryRaw<
      Array<{ closed: boolean; start_time: string | null; end_time: string | null }>
    >`
      SELECT closed, start_time, end_time
      FROM schedule_exceptions
      WHERE tenant_id=${tenantId}::uuid AND date=${date}::date
      LIMIT 1
    `;
    if (exception?.closed) return [];
    if (exception?.start_time && exception.end_time)
      return [{ start_time: exception.start_time, end_time: exception.end_time }];
    return tx.$queryRaw<Period[]>`
      SELECT start_time, end_time
      FROM business_hours
      WHERE tenant_id=${tenantId}::uuid
        AND weekday=EXTRACT(ISODOW FROM ${date}::date)::int
        AND enabled=true
      ORDER BY start_time
      LIMIT 10
    `;
  }

  private async isCandidateInPeriods(
    tx: Prisma.TransactionClient,
    startsAt: Date,
    date: string,
    periods: Period[],
    timezone: string,
    durationMinutes: number,
  ): Promise<boolean> {
    for (const period of periods) {
      const [row] = await tx.$queryRaw<Array<{ valid: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM generate_series(
            (${date}::date + ${period.start_time}::time) AT TIME ZONE ${timezone},
            ((${date}::date + ${period.end_time}::time) AT TIME ZONE ${timezone}) -
              make_interval(mins => ${durationMinutes}::int),
            interval '15 minutes'
          ) AS candidate
          WHERE candidate=${startsAt}::timestamptz
        ) AS valid
      `;
      if (row?.valid) return true;
    }
    return false;
  }
}

export function registerRescheduleBookingTool(
  registry: ToolRegistry,
  rescheduler: BookingRescheduler,
): void {
  registry.register({
    definition: {
      name: 'reschedule_booking',
      description:
        'Move one booking belonging to the current customer to one exact confirmed time while preserving its service and resource. Use the version returned by get_booking as expectedVersion. If status is stale, read the booking again before asking for confirmation. Never claim success unless this tool returns status rescheduled.',
      inputSchema: {
        type: 'object',
        properties: {
          bookingId: { type: 'string', format: 'uuid' },
          expectedVersion: { type: 'integer', minimum: 1 },
          startsAt: { type: 'string', format: 'date-time' },
          confirmed: { type: 'boolean', enum: [true] },
        },
        required: ['bookingId', 'expectedVersion', 'startsAt', 'confirmed'],
        additionalProperties: false,
      },
    },
    effect: 'write',
    requiredCapabilities: ['booking.reschedule'],
    supportsIdempotency: true,
    validateArguments,
    execute: async (context, arguments_, signal): Promise<JsonValue> =>
      toJson(
        await rescheduler.reschedule(
          {
            tenantId: context.tenantId,
            conversationId: context.conversationId,
            customerId: context.customerId,
            turnId: context.turnId,
            expectedModeEpoch: context.expectedModeEpoch,
            idempotencyKey: context.idempotencyKey,
            executionMode: context.executionMode,
            bookingId: arguments_.bookingId as string,
            expectedVersion: arguments_.expectedVersion as number,
            startsAt: arguments_.startsAt as string,
            confirmed: true,
          },
          signal,
        ),
      ),
  });
}
