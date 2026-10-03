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
}

export class PrismaBookingCalendarReconciliationStore
  implements BookingCalendarReconciliationStore
{
  constructor(private readonly deps: Dependencies) {}

  async targets(limit: number): Promise<BookingCalendarReconciliationTarget[]> {
    const rows = await this.deps.db.$queryRaw<TargetRow[]>`
      SELECT event.tenant_id::text AS "tenantId",
        event.connection_id::text AS "connectionId",
        connection.calendar_ref AS "calendarRef",
        connection.credential_ref AS "credentialRef",
        connection.provider,
        event.booking_id::text AS "bookingId",
        booking.version AS "bookingVersion",
        booking.status='cancelled' AS cancelled,
        event.external_event_id AS "externalEventId",
        event.external_version AS "externalVersion",
        booking.starts_at AS "startsAt",
        booking.ends_at AS "endsAt",
        booking.timezone
      FROM booking_calendar_events event
      JOIN calendar_connections connection
        ON connection.tenant_id=event.tenant_id AND connection.id=event.connection_id
        AND connection.status='connected'
      JOIN bookings booking
        ON booking.tenant_id=event.tenant_id AND booking.id=event.booking_id
      ORDER BY event.reconciled_at, event.tenant_id, event.booking_id
      LIMIT ${limit}
    `;
    return rows
      .filter((row) => row.credentialRef)
      .map((row) => ({
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
      }));
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
            updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${target.tenantId}::uuid
          AND connection_id=${target.connection.connectionId}::uuid
          AND booking_id=${target.bookingId}::uuid
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
