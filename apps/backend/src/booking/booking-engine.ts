import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Dependencies } from '../dependencies';

export interface AvailabilityRequest {
  tenantId: string;
  serviceId: string;
  date: string;
  staffId?: string;
}

export interface BookingSlot {
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityResult {
  timezone: string;
  resourceId: string;
  staffId: string | null;
  slots: BookingSlot[];
}

export interface CreateBookingRequest {
  tenantId: string;
  conversationId: string;
  customerId: string;
  turnId: string;
  expectedModeEpoch: bigint;
  idempotencyKey: string;
  executionMode: 'live' | 'sandbox';
  serviceId: string;
  startsAt: string;
  staffId?: string;
  confirmed: true;
}

export type CreateBookingResult =
  | {
      status: 'created';
      bookingId: string;
      startsAt: string;
      endsAt: string;
      timezone: string;
      staffId: string | null;
      duplicate: boolean;
    }
  | { status: 'unavailable' };

interface Period {
  startTime: string;
  endTime: string;
}

interface BookingSelection {
  timezone: string;
  resourceId: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  price: string;
  currency: string;
}

interface ExistingBooking {
  id: string;
  conversation_id: string | null;
  customer_id: string;
  turn_id: string | null;
  arguments_hash: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string | null;
}

function validateDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Invalid booking date');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error('Invalid booking date');
}

function parseBookingInstant(value: string): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Booking time requires an offset');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invalid booking time');
  return parsed;
}

function bookingArgumentsHash(input: CreateBookingRequest, startsAt: Date): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        serviceId: input.serviceId,
        startsAt: startsAt.toISOString(),
        staffId: input.staffId ?? null,
        confirmed: true,
      }),
    )
    .digest('hex');
}

export class BookingEngine {
  constructor(private readonly deps: Dependencies) {}

  async ensureDefaultResource(tenantId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return this.ensureDefaultResourceInTransaction(tx, tenantId);
    });
  }

  async availableSlots(
    input: AvailabilityRequest,
    signal: AbortSignal,
  ): Promise<AvailabilityResult> {
    validateDate(input.date);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const selection = await this.resolveSelectionInTransaction(
        tx,
        input.tenantId,
        input.serviceId,
        input.staffId,
      );
      const periods = await this.periodsInTransaction(tx, input.tenantId, input.date);
      const slots: BookingSlot[] = [];
      for (const period of periods) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const rows = await tx.$queryRaw<Array<{ starts_at: Date; ends_at: Date }>>`
          WITH bounds AS (
            SELECT
              (${input.date}::date + ${period.startTime}::time) AT TIME ZONE ${selection.timezone} AS starts_at,
              (${input.date}::date + ${period.endTime}::time) AT TIME ZONE ${selection.timezone} AS ends_at
          ), candidates AS (
            SELECT candidate AS starts_at
            FROM bounds,
              LATERAL generate_series(
                bounds.starts_at,
                bounds.ends_at - make_interval(mins => ${selection.durationMinutes}::int),
                interval '15 minutes'
              ) AS candidate
          )
          SELECT
            candidates.starts_at,
            candidates.starts_at + make_interval(mins => ${selection.durationMinutes}::int) AS ends_at
          FROM candidates
          WHERE NOT EXISTS (
            SELECT 1
            FROM bookings booking
            WHERE booking.tenant_id=${input.tenantId}::uuid
              AND booking.resource_id=${selection.resourceId}::uuid
              AND booking.status IN ('pending', 'confirmed')
              AND tstzrange(booking.occupied_start_at, booking.occupied_end_at, '[)') &&
                tstzrange(
                  candidates.starts_at - make_interval(mins => ${selection.bufferBeforeMinutes}::int),
                  candidates.starts_at + make_interval(mins => ${selection.durationMinutes + selection.bufferAfterMinutes}::int),
                  '[)'
                )
          )
          ORDER BY candidates.starts_at
          LIMIT 50
        `;
        slots.push(
          ...rows.map((row) => ({
            startsAt: row.starts_at.toISOString(),
            endsAt: row.ends_at.toISOString(),
          })),
        );
        if (slots.length >= 50) break;
      }

      return {
        timezone: selection.timezone,
        resourceId: selection.resourceId,
        staffId: input.staffId ?? null,
        slots: slots.slice(0, 50),
      };
    });
  }

  async createBooking(
    input: CreateBookingRequest,
    signal: AbortSignal,
  ): Promise<CreateBookingResult> {
    if (input.executionMode !== 'live') throw new Error('Booking creation is live-only');
    if (input.confirmed !== true) throw new Error('Booking requires explicit confirmation');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const startsAt = parseBookingInstant(input.startsAt);
    const hash = bookingArgumentsHash(input, startsAt);

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;

      const conversations = await tx.$queryRaw<Array<{ mode: string; mode_epoch: bigint }>>`
        SELECT mode, mode_epoch
        FROM conversations
        WHERE tenant_id=${input.tenantId}::uuid
          AND id=${input.conversationId}::uuid
          AND customer_id=${input.customerId}::uuid
        FOR UPDATE
      `;
      const conversation = conversations[0];
      if (conversation?.mode !== 'AI_ACTIVE' || conversation.mode_epoch !== input.expectedModeEpoch)
        throw new Error('Booking creation is stale');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const selection = await this.resolveSelectionInTransaction(
        tx,
        input.tenantId,
        input.serviceId,
        input.staffId,
      );
      const lockedResources = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text
        FROM booking_resources
        WHERE tenant_id=${input.tenantId}::uuid
          AND id=${selection.resourceId}::uuid
          AND active=true
        FOR UPDATE
      `;
      if (!lockedResources.length) throw new Error('Booking resource is unavailable');

      const [local] = await tx.$queryRaw<Array<{ local_date: string }>>`
        SELECT to_char(${startsAt}::timestamptz AT TIME ZONE ${selection.timezone}, 'YYYY-MM-DD') AS local_date
      `;
      if (!local) throw new Error('Booking time is unavailable');
      const periods = await this.periodsInTransaction(tx, input.tenantId, local.local_date);
      if (!(await this.isCandidateInPeriods(tx, startsAt, local.local_date, periods, selection)))
        return { status: 'unavailable' };

      const endsAt = new Date(startsAt.getTime() + selection.durationMinutes * 60_000);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO bookings (
          tenant_id, customer_id, service_id, resource_id, conversation_id, source, status,
          starts_at, ends_at, buffer_before_minutes, buffer_after_minutes, idempotency_key,
          turn_id, arguments_hash, timezone, duration_minutes, price_snapshot, currency_snapshot
        ) VALUES (
          ${input.tenantId}::uuid, ${input.customerId}::uuid, ${input.serviceId}::uuid,
          ${selection.resourceId}::uuid, ${input.conversationId}::uuid, 'ai', 'confirmed',
          ${startsAt}, ${endsAt}, ${selection.bufferBeforeMinutes}, ${selection.bufferAfterMinutes},
          ${input.idempotencyKey}, ${input.turnId}::uuid, ${hash}, ${selection.timezone},
          ${selection.durationMinutes}, ${selection.price}::numeric(20,6), ${selection.currency}
        )
        ON CONFLICT DO NOTHING
        RETURNING id::text
      `;

      if (!inserted.length) {
        const previous = await tx.$queryRaw<ExistingBooking[]>`
          SELECT id::text, conversation_id::text, customer_id::text, turn_id::text,
            arguments_hash, starts_at, ends_at, timezone
          FROM bookings
          WHERE tenant_id=${input.tenantId}::uuid AND idempotency_key=${input.idempotencyKey}
          LIMIT 1
        `;
        const row = previous[0];
        if (!row) return { status: 'unavailable' };
        if (
          row.conversation_id !== input.conversationId ||
          row.customer_id !== input.customerId ||
          row.turn_id !== input.turnId ||
          row.arguments_hash !== hash ||
          !row.timezone
        )
          throw new Error('Idempotency conflict');
        return {
          status: 'created',
          bookingId: row.id,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          timezone: row.timezone,
          staffId: input.staffId ?? null,
          duplicate: true,
        };
      }

      const bookingId = inserted[0]!.id;
      await tx.$executeRaw`
        INSERT INTO booking_outbox (tenant_id, booking_id, event_type)
        VALUES (${input.tenantId}::uuid, ${bookingId}::uuid, 'created')
      `;
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          tenantId: input.tenantId,
          actorId: null,
          actorType: 'system',
          action: 'ai.booking_created',
          targetId: bookingId,
        },
      });

      return {
        status: 'created',
        bookingId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        timezone: selection.timezone,
        staffId: input.staffId ?? null,
        duplicate: false,
      };
    });
  }

  private async resolveSelectionInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    serviceId: string,
    staffId?: string,
  ): Promise<BookingSelection> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    if (!tenant) throw new Error('Booking tenant is unavailable');

    const service = await tx.businessService.findFirst({
      where: { tenantId, id: serviceId, active: true, deletedAt: null, bookingEnabled: true },
      select: {
        price: true,
        currency: true,
        durationMinutes: true,
        bufferBeforeMinutes: true,
        bufferAfterMinutes: true,
      },
    });
    if (!service) throw new Error('Booking service is unavailable');

    let resourceId: string;
    let durationMinutes = service.durationMinutes;
    let price = service.price.toString();
    if (staffId) {
      const staffService = await tx.staffService.findFirst({
        where: {
          tenantId,
          staffId,
          serviceId,
          active: true,
          staff: { is: { active: true } },
        },
        select: {
          customDurationMinutes: true,
          customPrice: true,
          staff: { select: { name: true } },
        },
      });
      if (!staffService) throw new Error('Booking staff is unavailable');
      durationMinutes = staffService.customDurationMinutes ?? durationMinutes;
      price = (staffService.customPrice ?? service.price).toString();
      resourceId = await this.ensureStaffResourceInTransaction(
        tx,
        tenantId,
        staffId,
        staffService.staff.name,
      );
    } else {
      resourceId = await this.ensureDefaultResourceInTransaction(tx, tenantId);
    }

    return {
      timezone: tenant.timezone,
      resourceId,
      durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      price,
      currency: service.currency,
    };
  }

  private async periodsInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    date: string,
  ): Promise<Period[]> {
    validateDate(date);
    const day = new Date(`${date}T00:00:00Z`);
    const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    const exception = await tx.scheduleException.findFirst({
      where: { tenantId, date: day },
      select: { closed: true, startTime: true, endTime: true },
    });
    if (exception?.closed) return [];
    if (exception?.startTime && exception.endTime)
      return [{ startTime: exception.startTime, endTime: exception.endTime }];
    return tx.businessHour.findMany({
      where: { tenantId, weekday, enabled: true },
      select: { startTime: true, endTime: true },
      orderBy: { startTime: 'asc' },
      take: 10,
    });
  }

  private async isCandidateInPeriods(
    tx: Prisma.TransactionClient,
    startsAt: Date,
    date: string,
    periods: Period[],
    selection: BookingSelection,
  ): Promise<boolean> {
    for (const period of periods) {
      const [row] = await tx.$queryRaw<Array<{ valid: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM generate_series(
            (${date}::date + ${period.startTime}::time) AT TIME ZONE ${selection.timezone},
            ((${date}::date + ${period.endTime}::time) AT TIME ZONE ${selection.timezone}) -
              make_interval(mins => ${selection.durationMinutes}::int),
            interval '15 minutes'
          ) AS candidate
          WHERE candidate=${startsAt}::timestamptz
        ) AS valid
      `;
      if (row?.valid) return true;
    }
    return false;
  }

  private async ensureDefaultResourceInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO booking_resources (tenant_id, kind, name)
      VALUES (${tenantId}::uuid, 'default', 'Default resource')
      ON CONFLICT DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM booking_resources
      WHERE tenant_id=${tenantId}::uuid AND kind='default' AND active=true
      LIMIT 1
    `;
    const resource = rows[0];
    if (!resource) throw new Error('Default booking resource is unavailable');
    return resource.id;
  }

  private async ensureStaffResourceInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    staffId: string,
    name: string,
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO booking_resources (tenant_id, kind, staff_id, name)
      VALUES (${tenantId}::uuid, 'staff', ${staffId}::uuid, ${name})
      ON CONFLICT DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM booking_resources
      WHERE tenant_id=${tenantId}::uuid AND staff_id=${staffId}::uuid AND kind='staff' AND active=true
      LIMIT 1
    `;
    const resource = rows[0];
    if (!resource) throw new Error('Staff booking resource is unavailable');
    return resource.id;
  }
}
