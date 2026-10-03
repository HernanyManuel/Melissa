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
import { startBookingCalendarRuntime } from '../src/calendar/booking-calendar-runtime';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

class RecordingProvider implements CalendarProvider {
  readonly providerKey = 'mock';
  readonly calls: CalendarBookingMutation[] = [];
  async busy(_request: CalendarBusyRequest): Promise<CalendarBusyResult> {
    throw new Error('Unexpected busy call');
  }
  async upsertBooking(request: CalendarBookingMutation): Promise<CalendarExternalEvent> {
    this.calls.push(request);
    return { externalEventId: 'external-1', version: '1', cancelled: false };
  }
  async cancelBooking(_request: CalendarBookingCancellation): Promise<CalendarExternalEvent> {
    throw new Error('Unexpected cancellation');
  }
}

test('booking calendar runtime delivers an opaque dispatch exactly once', { timeout: 15000 }, async () => {
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
      data: { id: tenantId, name: 'Booking calendar fixture', countryCode: 'PT', timezone: 'Europe/Lisbon' },
    });
    await admin.staff.create({
      data: { id: staffId, tenantId, name: 'Booking staff', timezone: 'Europe/Lisbon' },
    });
    await admin.customer.create({
      data: { id: customerId, tenantId, displayName: 'Booking customer', phoneE164: '+351910000001' },
    });
    await admin.businessService.create({
      data: { id: serviceId, tenantId, name: 'Booking service', slug: `booking-${serviceId}`, price: 10, currency: 'EUR', durationMinutes: 30 },
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

    stop = await startBookingCalendarRuntime(deps, config.REDIS_URL, secrets as never, { provider });
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
  } finally {
    if (stop) await stop();
    await admin.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
