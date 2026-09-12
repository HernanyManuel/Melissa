import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Dependencies } from '../dependencies';
import {
  evaluateBookingCreationPolicyInTransaction,
  readBookingCreationWindowInTransaction,
} from './booking-policy';
import {
  BookingPeriod,
  effectiveBookingPeriodsInTransaction,
  isBookingCandidateInPeriods,
  isBookingResourceUnblockedInTransaction,
  localBookingDateInTransaction,
} from './booking-schedule';

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
  | { status: 'unavailable' }
  | {
      status: 'policy_denied';
      reason: 'minimum_notice' | 'maximum_horizon';
      minimumNoticeMinutes: number;
      maximumHorizonDays: number | null;
    };

interface BookingSelection {
  timezone: string;
  resourceId: string;
  staffId: string | null;
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
  staff_id: string | null;
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

      const creationWindow = await readBookingCreationWindowInTransaction(tx, input.tenantId);
      const selection = await this.resolveSelectionInTransaction(
        tx,
        input.tenantId,
        input.serviceId,
        input.staffId,
      );
      const periods = await this.periodsInTransaction(
        tx,
        input.tenantId,
        input.date,
        selection.staffId,
      );
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
          WHERE candidates.starts_at >= ${creationWindow.earliestStartsAt}::timestamptz
            AND (
              ${creationWindow.latestStartsAt}::timestamptz IS NULL OR
              candidates.starts_at <= ${creationWindow.latestStartsAt}::timestamptz
            )
            AND NOT EXISTS (
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
            AND NOT EXISTS (
              SELECT 1
              FROM resource_blocks block
              WHERE block.tenant_id=${input.tenantId}::uuid
                AND block.resource_id=${selection.resourceId}::uuid
                AND tstzrange(block.starts_at, block.ends_at, '[)') &&
                  tstzrange(
                    candidates.starts_at - make_interval(mins => ${selection.bufferBeforeMinutes}::int),
                    candidates.starts_at + make_interval(mins => ${selection.durationMinutes + selection.bufferAfterMinutes}::int),
                    '[)'
                  )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM calendar_connections connection
              JOIN booking_resources resource
                ON resource.tenant_id=connection.tenant_id
              WHERE connection.tenant_id=${input.tenantId}::uuid
                AND resource.tenant_id=${input.tenantId}::uuid
                AND resource.id=${selection.resourceId}::uuid
                AND connection.staff_id IS NOT DISTINCT FROM resource.staff_id
                AND NOT (
                  connection.status='connected'
                  AND connection.last_success_at IS NOT NULL
                  AND connection.last_success_at <= CURRENT_TIMESTAMP
                  AND connection.last_success_at +
                    make_interval(secs => connection.freshness_limit_seconds) >= CURRENT_TIMESTAMP
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM calendar_busy_intervals busy
              JOIN calendar_connections connection
                ON connection.tenant_id=busy.tenant_id AND connection.id=busy.connection_id
              JOIN booking_resources resource
                ON resource.tenant_id=connection.tenant_id
              WHERE connection.tenant_id=${input.tenantId}::uuid
                AND resource.tenant_id=${input.tenantId}::uuid
                AND resource.id=${selection.resourceId}::uuid
                AND connection.staff_id IS NOT DISTINCT FROM resource.staff_id
                AND busy.sync_version=connection.sync_version
                AND tstzrange(busy.starts_at, busy.ends_at, '[)') &&
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
        staffId: selection.staffId,
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

      const replay = await this.findExistingBookingInTransaction(
        tx,
        input.tenantId,
        input.idempotencyKey,
      );
      if (replay) return this.resolveCreateReplay(replay, input, hash);

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

      const creationPolicy = await evaluateBookingCreationPolicyInTransaction(
        tx,
        input.tenantId,
        startsAt,
      );
      if (!creationPolicy.allowed) {
        return {
          status: 'policy_denied',
          reason: creationPolicy.reason,
          minimumNoticeMinutes: creationPolicy.minimumNoticeMinutes,
          maximumHorizonDays: creationPolicy.maximumHorizonDays,
        };
      }

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

      const localDate = await localBookingDateInTransaction(tx, startsAt, selection.timezone);
      const periods = await this.periodsInTransaction(
        tx,
        input.tenantId,
        localDate,
        selection.staffId,
      );
      if (!(await this.isCandidateInPeriods(tx, startsAt, localDate, periods, selection)))
        return { status: 'unavailable' };
      if (
        !(await isBookingResourceUnblockedInTransaction(
          tx,
          input.tenantId,
          selection.resourceId,
          startsAt,
          selection.durationMinutes,
          selection.bufferBeforeMinutes,
          selection.bufferAfterMinutes,
        ))
      )
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
        const previous = await this.findExistingBookingInTransaction(
          tx,
          input.tenantId,
          input.idempotencyKey,
        );
        if (!previous) return { status: 'unavailable' };
        return this.resolveCreateReplay(previous, input, hash);
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
        staffId: selection.staffId,
        duplicate: false,
      };
    });
  }

  private async findExistingBookingInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ExistingBooking | undefined> {
    const rows = await tx.$queryRaw<ExistingBooking[]>`
      SELECT booking.id::text, booking.conversation_id::text, booking.customer_id::text,
        booking.turn_id::text, booking.arguments_hash, booking.starts_at, booking.ends_at,
        booking.timezone, resource.staff_id::text
      FROM bookings booking
      JOIN booking_resources resource
        ON resource.tenant_id=booking.tenant_id AND resource.id=booking.resource_id
      WHERE booking.tenant_id=${tenantId}::uuid AND booking.idempotency_key=${idempotencyKey}
      LIMIT 1
    `;
    return rows[0];
  }

  private resolveCreateReplay(
    row: ExistingBooking,
    input: CreateBookingRequest,
    hash: string,
  ): CreateBookingResult {
    if (
      row.conversation_id !== input.conversationId ||
      row.customer_id !== input.customerId ||
      row.turn_id !== input.turnId ||
      row.arguments_hash !== hash
    )
      throw new Error('Idempotency conflict');
    if (!row.timezone) throw new Error('Booking replay is inconsistent');
    return {
      status: 'created',
      bookingId: row.id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      timezone: row.timezone,
      staffId: row.staff_id,
      duplicate: true,
    };
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
      staffId: staffId ?? null,
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
    staffId: string | null,
  ): Promise<BookingPeriod[]> {
    return effectiveBookingPeriodsInTransaction(tx, tenantId, date, staffId);
  }

  private async isCandidateInPeriods(
    tx: Prisma.TransactionClient,
    startsAt: Date,
    date: string,
    periods: readonly BookingPeriod[],
    selection: BookingSelection,
  ): Promise<boolean> {
    return isBookingCandidateInPeriods(
      tx,
      startsAt,
      date,
      periods,
      selection.timezone,
      selection.durationMinutes,
    );
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
