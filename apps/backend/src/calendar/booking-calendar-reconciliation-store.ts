import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Dependencies } from '../dependencies';
import { CalendarExternalEvent } from './calendar-provider';
import {
  BookingCalendarReconciliationStore,
  BookingCalendarReconciliationTarget,
} from './booking-calendar-reconciler';

interface TargetRow {
  tenantId: string;
  connectionId: string;
  calendarRef: string;
  credentialRef: string | null;
  provider: string;
  bookingId: string;
  bookingVersion: number;
  cancelled: boolean;
  externalEventId: string;
  externalVersion: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  leaseId: string;
}

export class PrismaBookingCalendarReconciliationStore
  implements BookingCalendarReconciliationStore
{
  constructor(private readonly deps: Dependencies) {}

  async targets(limit: number): Promise<BookingCalendarReconciliationTarget[]> {
    const tenants = await this.deps.db.$queryRaw<Array<{ tenantId: string }>>`
      SELECT DISTINCT tenant_id::text AS "tenantId"
      FROM booking_calendar_dispatch
      ORDER BY tenant_id
      LIMIT 500
    `;
    const targets: BookingCalendarReconciliationTarget[] = [];
    for (const { tenantId } of tenants) {
      if (targets.length >= limit) break;
      const leaseId = randomUUID();
      const leaseUntil = new Date(Date.now() + 30_000);
      const rows = await this.scoped(
        tenantId,
        (tx) => tx.$queryRaw<TargetRow[]>`
        WITH candidates AS (
          SELECT event.tenant_id, event.connection_id, event.booking_id
          FROM booking_calendar_events event
          JOIN calendar_connections connection
            ON connection.tenant_id=event.tenant_id AND connection.id=event.connection_id
            AND connection.status='connected' AND connection.credential_ref IS NOT NULL
          WHERE event.tenant_id=${tenantId}::uuid
            AND (
              event.reconcile_lease_until IS NULL
              OR event.reconcile_lease_until <= CURRENT_TIMESTAMP
            )
          ORDER BY event.reconciled_at, event.booking_id
          FOR UPDATE OF event SKIP LOCKED
          LIMIT ${limit - targets.length}
        ),
        claimed AS (
          UPDATE booking_calendar_events event
          SET reconcile_lease_id=${leaseId}::uuid,
              reconcile_lease_until=${leaseUntil},
              updated_at=CURRENT_TIMESTAMP
          FROM candidates
          WHERE event.tenant_id=candidates.tenant_id
            AND event.connection_id=candidates.connection_id
            AND event.booking_id=candidates.booking_id
          RETURNING event.*
        )
        SELECT claimed.tenant_id::text AS "tenantId",
          claimed.connection_id::text AS "connectionId",
          connection.calendar_ref AS "calendarRef",
          connection.credential_ref AS "credentialRef",
          connection.provider,
          claimed.booking_id::text AS "bookingId",
          booking.version AS "bookingVersion",
          booking.status='cancelled' AS cancelled,
          claimed.external_event_id AS "externalEventId",
          claimed.external_version AS "externalVersion",
          booking.starts_at AS "startsAt",
          booking.ends_at AS "endsAt",
          booking.timezone,
          claimed.reconcile_lease_id::text AS "leaseId"
        FROM claimed
        JOIN calendar_connections connection
          ON connection.tenant_id=claimed.tenant_id AND connection.id=claimed.connection_id
        JOIN bookings booking
          ON booking.tenant_id=claimed.tenant_id AND booking.id=claimed.booking_id
        ORDER BY claimed.reconciled_at, claimed.booking_id
      `,
      );
      targets.push(
        ...rows.map((row) => ({
          tenantId: row.tenantId,
          connection: {
            connectionId: row.connectionId,
            calendarRef: row.calendarRef,
            credentialRef: row.credentialRef!,
          },
          provider: row.provider,
          bookingId: row.bookingId,
          bookingVersion: row.bookingVersion,
          cancelled: row.cancelled,
          externalEventId: row.externalEventId,
          externalVersion: row.externalVersion,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          timezone: row.timezone,
          leaseId: row.leaseId,
        })),
      );
    }
    return targets;
  }

  async persist(
    target: BookingCalendarReconciliationTarget,
    event: CalendarExternalEvent,
  ): Promise<void> {
    await this.scoped(target.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE booking_calendar_events
        SET external_event_id=${event.externalEventId},
            external_version=${event.version},
            cancelled=${event.cancelled},
            booking_version=${target.bookingVersion},
            reconciled_at=CURRENT_TIMESTAMP,
            reconcile_lease_id=NULL,
            reconcile_lease_until=NULL,
            updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${target.tenantId}::uuid
          AND connection_id=${target.connection.connectionId}::uuid
          AND booking_id=${target.bookingId}::uuid
          AND reconcile_lease_id=${target.leaseId}::uuid
      `;
    });
  }

  async release(target: BookingCalendarReconciliationTarget): Promise<void> {
    await this.scoped(target.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE booking_calendar_events
        SET reconcile_lease_id=NULL, reconcile_lease_until=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${target.tenantId}::uuid
          AND connection_id=${target.connection.connectionId}::uuid
          AND booking_id=${target.bookingId}::uuid
          AND reconcile_lease_id=${target.leaseId}::uuid
      `;
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
