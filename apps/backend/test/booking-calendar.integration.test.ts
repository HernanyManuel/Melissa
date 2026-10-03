import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  CalendarBookingCancellation,
  CalendarBookingMutation,
  CalendarBusyRequest,
  CalendarBusyResult,
  CalendarExternalEvent,
  CalendarProvider,
} from '../src/calendar/calendar-provider';
import { PrismaBookingCalendarReconciliationStore } from '../src/calendar/booking-calendar-reconciliation-store';
import { startBookingCalendarRuntime } from '../src/calendar/booking-calendar-runtime';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

class RecordingProvider implements CalendarProvider {
  readonly providerKey = 'mock';
  readonly calls: CalendarBookingMutation[] = [];
  readonly cancellations: CalendarBookingCancellation[] = [];
  async busy(request: CalendarBusyRequest): Promise<CalendarBusyResult> {
    void request;
    throw new Error('Unexpected busy call');
  }
  async upsertBooking(request: CalendarBookingMutation): Promise<CalendarExternalEvent> {
    this.calls.push(request);
    return {
      externalEventId: 'external-1',
      version: String(this.calls.length),
      cancelled: false,
    };
  }
  async cancelBooking(request: CalendarBookingCancellation): Promise<CalendarExternalEvent> {
    this.cancellations.push(request);
    return { externalEventId: 'external-1', version: '3', cancelled: true };
  }
}

test(
  'booking calendar runtime delivers an opaque dispatch exactly once',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'booking calendar integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const staffId = randomUUID();
    const customerId = randomUUID();
    const serviceId = randomUUID();
    const resourceId = randomUUID();
    const bookingId = randomUUID();
    const connectionId = randomUUID();
    const outboxId = randomUUID();
    const provider = new RecordingProvider();
    const secrets = { resolve: async () => null };
    let stop: (() => Promise<void>) | undefined;

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Booking calendar fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.staff.create({
        data: { id: staffId, tenantId, name: 'Booking staff', timezone: 'Europe/Lisbon' },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Booking customer',
          phoneE164: '+351910000001',
        },
      });
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Booking service',
          slug: `booking-${serviceId}`,
          price: 10,
          currency: 'EUR',
          durationMinutes: 30,
        },
      });
      await admin.$executeRaw`
        INSERT INTO booking_resources (tenant_id, id, kind, staff_id, name)
        VALUES (${tenantId}::uuid, ${resourceId}::uuid, 'staff', ${staffId}::uuid, 'Booking staff')
      `;
      await admin.$executeRaw`
        INSERT INTO bookings (
          tenant_id, id, customer_id, service_id, resource_id, status, starts_at, ends_at,
          occupied_start_at, occupied_end_at, version, timezone
        ) VALUES (
          ${tenantId}::uuid, ${bookingId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'confirmed', '2030-01-01T10:00:00Z', '2030-01-01T10:30:00Z',
          '2030-01-01T10:00:00Z', '2030-01-01T10:30:00Z', 1, 'Europe/Lisbon'
        )
      `;
      await admin.$executeRaw`
        INSERT INTO calendar_connections (tenant_id, id, staff_id, provider, calendar_ref, status)
        VALUES (${tenantId}::uuid, ${connectionId}::uuid, ${staffId}::uuid, 'mock', 'mock:booking', 'connected')
      `;
      await admin.$executeRaw`
        INSERT INTO booking_outbox (tenant_id, id, booking_id, event_type, booking_version)
        VALUES (${tenantId}::uuid, ${outboxId}::uuid, ${bookingId}::uuid, 'created', 1)
      `;
      await admin.$executeRaw`
        INSERT INTO booking_calendar_dispatch (tenant_id, id)
        VALUES (${tenantId}::uuid, ${outboxId}::uuid)
      `;

      stop = await startBookingCalendarRuntime(deps, config.REDIS_URL, secrets as never, {
        provider,
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await admin.$queryRaw<Array<{ state: string; processedAt: Date | null }>>`
          SELECT state, processed_at AS "processedAt"
          FROM booking_outbox WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
        `;
        if (row?.state === 'processed') {
          assert(row.processedAt);
          break;
        }
        await delay(100);
      }
      const [outbox] = await admin.$queryRaw<Array<{ state: string; processedAt: Date | null }>>`
        SELECT state, processed_at AS "processedAt"
        FROM booking_outbox WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      assert.equal(outbox?.state, 'processed');
      assert(outbox.processedAt);
      assert.equal(provider.calls.length, 1);
      assert.equal(provider.calls[0]?.bookingId, bookingId);
      assert.equal(provider.calls[0]?.connection.connectionId, connectionId);
      const [projection] = await admin.$queryRaw<
        Array<{
          externalEventId: string;
          externalVersion: string;
          cancelled: boolean;
          bookingVersion: number;
          reconciledAt: Date;
        }>
      >`
        SELECT external_event_id AS "externalEventId",
               external_version AS "externalVersion",
               cancelled,
               booking_version AS "bookingVersion",
               reconciled_at AS "reconciledAt"
        FROM booking_calendar_events
        WHERE tenant_id=${tenantId}::uuid
          AND connection_id=${connectionId}::uuid
          AND booking_id=${bookingId}::uuid
      `;
      assert.equal(projection?.externalEventId, 'external-1');
      assert.equal(projection?.externalVersion, '1');
      assert.equal(projection?.cancelled, false);
      assert.equal(projection?.bookingVersion, 1);
      assert(projection?.reconciledAt instanceof Date);

      const rescheduleId = randomUUID();
      await admin.$executeRaw`
        UPDATE bookings
        SET starts_at='2030-01-01T11:00:00Z',
            ends_at='2030-01-01T11:30:00Z',
            occupied_start_at='2030-01-01T11:00:00Z',
            occupied_end_at='2030-01-01T11:30:00Z',
            version=2
        WHERE tenant_id=${tenantId}::uuid AND id=${bookingId}::uuid
      `;
      await admin.$executeRaw`
        INSERT INTO booking_outbox (tenant_id, id, booking_id, event_type, booking_version)
        VALUES (${tenantId}::uuid, ${rescheduleId}::uuid, ${bookingId}::uuid, 'rescheduled', 2)
      `;
      await admin.$executeRaw`
        INSERT INTO booking_calendar_dispatch (tenant_id, id)
        VALUES (${tenantId}::uuid, ${rescheduleId}::uuid)
      `;
      for (let attempt = 0; attempt < 50 && provider.calls.length < 2; attempt++) await delay(100);
      assert.equal(provider.calls.length, 2);
      assert.equal(provider.calls[1]?.startsAt, '2030-01-01T11:00:00.000Z');
      const [rescheduled] = await admin.$queryRaw<
        Array<{ externalVersion: string; cancelled: boolean; bookingVersion: number }>
      >`
        SELECT external_version AS "externalVersion", cancelled, booking_version AS "bookingVersion"
        FROM booking_calendar_events
        WHERE tenant_id=${tenantId}::uuid
          AND connection_id=${connectionId}::uuid
          AND booking_id=${bookingId}::uuid
      `;
      assert.equal(rescheduled?.externalVersion, '2');
      assert.equal(rescheduled?.cancelled, false);
      assert.equal(rescheduled?.bookingVersion, 2);

      const cancelId = randomUUID();
      await admin.$executeRaw`
        UPDATE bookings
        SET status='cancelled',
            cancelled_at=CURRENT_TIMESTAMP,
            cancellation_reason='integration reconciliation',
            version=3
        WHERE tenant_id=${tenantId}::uuid AND id=${bookingId}::uuid
      `;
      await admin.$executeRaw`
        INSERT INTO booking_outbox (tenant_id, id, booking_id, event_type, booking_version)
        VALUES (${tenantId}::uuid, ${cancelId}::uuid, ${bookingId}::uuid, 'cancelled', 3)
      `;
      await admin.$executeRaw`
        INSERT INTO booking_calendar_dispatch (tenant_id, id)
        VALUES (${tenantId}::uuid, ${cancelId}::uuid)
      `;
      for (let attempt = 0; attempt < 50 && provider.cancellations.length < 1; attempt++)
        await delay(100);
      assert.equal(provider.cancellations.length, 1);
      const [cancelled] = await admin.$queryRaw<
        Array<{
          externalEventId: string;
          externalVersion: string;
          cancelled: boolean;
          bookingVersion: number;
        }>
      >`
        SELECT external_event_id AS "externalEventId",
               external_version AS "externalVersion",
               cancelled,
               booking_version AS "bookingVersion"
        FROM booking_calendar_events
        WHERE tenant_id=${tenantId}::uuid
          AND connection_id=${connectionId}::uuid
          AND booking_id=${bookingId}::uuid
      `;
      assert.equal(cancelled?.externalEventId, 'external-1');
      assert.equal(cancelled?.externalVersion, '3');
      assert.equal(cancelled?.cancelled, true);
      assert.equal(cancelled?.bookingVersion, 3);

      await admin.$executeRaw`
        UPDATE calendar_connections
        SET credential_ref='secret://calendar/integration'
        WHERE tenant_id=${tenantId}::uuid AND id=${connectionId}::uuid
      `;
      const firstStore = new PrismaBookingCalendarReconciliationStore(deps);
      const secondStore = new PrismaBookingCalendarReconciliationStore(deps);
      const [firstClaim, secondClaim] = await Promise.all([
        firstStore.targets(1),
        secondStore.targets(1),
      ]);
      const claims = [...firstClaim, ...secondClaim].filter(
        (target) => target.bookingId === bookingId && target.connection.connectionId === connectionId,
      );
      assert.equal(claims.length, 1);
      const winner = claims[0];
      assert(winner);
      const loserRetry = winner === firstClaim[0] ? await secondStore.targets(1) : await firstStore.targets(1);
      assert.equal(
        loserRetry.some(
          (target) =>
            target.bookingId === bookingId && target.connection.connectionId === connectionId,
        ),
        false,
      );
      await (winner === firstClaim[0] ? firstStore : secondStore).release(winner);
    } finally {
      if (stop) await stop();
      await admin.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
