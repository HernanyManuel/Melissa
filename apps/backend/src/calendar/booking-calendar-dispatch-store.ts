import { Prisma } from '@prisma/client';
import { Dependencies } from '../dependencies';

export interface BookingCalendarDispatchRoute {
  id: string;
  attempt: number;
}

export interface BookingCalendarDispatchClaim {
  id: string;
  tenantId: string;
  bookingId: string;
  eventType: 'created' | 'cancelled' | 'rescheduled';
  bookingVersion: number;
  connectionId: string;
  provider: string;
  calendarRef: string;
  credentialRef: string | null;
  attempt: number;
}

interface ClaimRow extends BookingCalendarDispatchClaim {
  state: string;
  nextAttemptAt: Date;
}

interface BookingSnapshot {
  startsAt: string;
  endsAt: string;
  timezone: string;
}

interface BookingSnapshotRow {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}

export class BookingCalendarDispatchStore {
  constructor(private readonly deps: Dependencies) {}

  async due(limit = 100): Promise<BookingCalendarDispatchRoute[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid limit');
    }
    return this.deps.db.$queryRaw<BookingCalendarDispatchRoute[]>`
      SELECT id::text, attempts AS attempt
      FROM booking_calendar_dispatch
      WHERE state='pending' AND next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY next_attempt_at, id
      LIMIT ${limit}
    `;
  }

  async claim(
    id: string,
    attempt: number,
  ): Promise<BookingCalendarDispatchClaim | null> {
    const [route] = await this.deps.db.$queryRaw<Array<{ tenantId: string }>>`
      SELECT tenant_id::text AS "tenantId"
      FROM booking_calendar_dispatch
      WHERE id=${id}::uuid
    `;
    if (!route) return null;
    return this.scoped(route.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<ClaimRow[]>`
        SELECT dispatch.id::text, dispatch.tenant_id::text AS "tenantId",
          outbox.booking_id::text AS "bookingId", outbox.event_type AS "eventType",
          outbox.booking_version AS "bookingVersion",
          connection.id::text AS "connectionId", connection.provider,
          connection.calendar_ref AS "calendarRef",
          connection.credential_ref AS "credentialRef",
          dispatch.attempts AS attempt, dispatch.state,
          dispatch.next_attempt_at AS "nextAttemptAt"
        FROM booking_calendar_dispatch dispatch
        JOIN booking_outbox outbox
          ON outbox.tenant_id=dispatch.tenant_id AND outbox.id=dispatch.id
        JOIN bookings booking
          ON booking.tenant_id=outbox.tenant_id AND booking.id=outbox.booking_id
        JOIN booking_resources resource
          ON resource.tenant_id=booking.tenant_id AND resource.id=booking.resource_id
          AND resource.kind='staff' AND resource.staff_id IS NOT NULL
        JOIN calendar_connections connection
          ON connection.tenant_id=resource.tenant_id AND connection.staff_id=resource.staff_id
          AND connection.status='connected'
        WHERE dispatch.tenant_id=${route.tenantId}::uuid AND dispatch.id=${id}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM calendar_connections other
            WHERE other.tenant_id=connection.tenant_id
              AND other.staff_id=connection.staff_id
              AND other.status='connected' AND other.id<>connection.id
          )
      `;
      if (!row || row.state !== 'pending' || row.attempt !== attempt) return null;
      if (row.nextAttemptAt > new Date()) return null;
      return {
        id: row.id,
        tenantId: row.tenantId,
        bookingId: row.bookingId,
        eventType: row.eventType,
        bookingVersion: row.bookingVersion,
        connectionId: row.connectionId,
        provider: row.provider,
        calendarRef: row.calendarRef,
        credentialRef: row.credentialRef,
        attempt: row.attempt,
      };
    });
  }

  async bookingSnapshot(
    claim: BookingCalendarDispatchClaim,
  ): Promise<BookingSnapshot | null> {
    return this.scoped(claim.tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<BookingSnapshotRow[]>`
        SELECT starts_at AS "startsAt", ends_at AS "endsAt", timezone
        FROM bookings
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.bookingId}::uuid
          AND version=${claim.bookingVersion}
      `;
      if (!row) return null;
      return {
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        timezone: row.timezone,
      };
    });
  }

  async accept(claim: BookingCalendarDispatchClaim): Promise<void> {
    await this.scoped(claim.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE booking_calendar_dispatch
        SET state='processed'
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}
      `;
      if (updated !== 1) return;
      const outboxUpdated = await tx.$executeRaw`
        UPDATE booking_outbox
        SET state='processed', processed_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}
      `;
      if (outboxUpdated !== 1) throw new Error('Calendar outbox state mismatch');
    });
  }

  async recordFailure(claim: BookingCalendarDispatchClaim): Promise<void> {
    await this.scoped(claim.tenantId, async (tx) => {
      const attempts = claim.attempt + 1;
      const terminal = attempts >= 5;
      const state = terminal ? 'failed' : 'pending';
      const nextAttemptAt = new Date(
        Date.now() + Math.min(60_000, 1000 * 2 ** claim.attempt),
      );
      const updated = await tx.$executeRaw`
        UPDATE booking_calendar_dispatch
        SET attempts=${attempts}, state=${state}, next_attempt_at=${nextAttemptAt}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}
      `;
      if (updated !== 1) return;
      const outboxUpdated = await tx.$executeRaw`
        UPDATE booking_outbox
        SET attempts=${attempts}, state=${state}, next_attempt_at=${nextAttemptAt}
        WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.id}::uuid
          AND state='pending' AND attempts=${claim.attempt}
      `;
      if (outboxUpdated !== 1) throw new Error('Calendar outbox state mismatch');
    });
  }

  private scoped<T>(
    tenantId: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }
}
