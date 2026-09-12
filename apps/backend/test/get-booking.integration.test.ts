import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaBookingReader } from '../src/ai/get-booking-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('get_booking reads only bookings owned by the trusted customer scope', async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'get booking integration requires MIGRATION_DATABASE_URL');
  const deps = new Dependencies(parseConfig(process.env));
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const customerId = randomUUID();
  const otherCustomerId = randomUUID();
  const serviceId = randomUUID();
  const resourceId = randomUUID();
  const bookingId = randomUUID();
  const reader = new PrismaBookingReader(deps);

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Get booking fixture',
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.customer.createMany({
      data: [
        {
          id: customerId,
          tenantId,
          displayName: 'Booking owner',
          phoneE164: `+35191${Math.floor(Math.random() * 10_000_000)
            .toString()
            .padStart(7, '0')}`,
          language: 'pt',
        },
        {
          id: otherCustomerId,
          tenantId,
          displayName: 'Other customer',
          phoneE164: `+35192${Math.floor(Math.random() * 10_000_000)
            .toString()
            .padStart(7, '0')}`,
          language: 'pt',
        },
      ],
    });
    await admin.businessService.create({
      data: {
        id: serviceId,
        tenantId,
        name: 'Readable service',
        slug: `get-booking-${serviceId}`,
        price: '22.00',
        currency: 'EUR',
        durationMinutes: 45,
      },
    });
    await admin.$executeRaw`
      INSERT INTO booking_resources (tenant_id, id, kind, name)
      VALUES (${tenantId}::uuid, ${resourceId}::uuid, 'default', 'Readable resource')
      ON CONFLICT DO NOTHING
    `;
    await admin.$executeRaw`
      INSERT INTO bookings (
        tenant_id, id, customer_id, service_id, resource_id, source, status,
        starts_at, ends_at, buffer_before_minutes, buffer_after_minutes,
        timezone, duration_minutes, price_snapshot, currency_snapshot
      ) VALUES (
        ${tenantId}::uuid, ${bookingId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
        ${resourceId}::uuid, 'manual', 'confirmed',
        '2026-09-16T08:00:00Z'::timestamptz, '2026-09-16T08:45:00Z'::timestamptz,
        0, 0, 'Europe/Lisbon', 45, 22.00, 'EUR'
      )
    `;

    const own = await reader.getBooking(
      { tenantId, customerId, bookingId },
      new AbortController().signal,
    );
    assert.equal(own.found, true);
    assert.equal(own.bookingId, bookingId);
    assert.equal(own.version, 1);
    assert.equal(own.serviceName, 'Readable service');
    assert.equal(own.status, 'confirmed');
    assert.equal(own.startsAt, '2026-09-16T08:00:00.000Z');
    assert.equal(own.endsAt, '2026-09-16T08:45:00.000Z');
    assert.equal(own.timezone, 'Europe/Lisbon');
    assert.equal(own.amount, '22.000000');
    assert.equal(own.currency, 'EUR');

    const foreignCustomer = await reader.getBooking(
      { tenantId, customerId: otherCustomerId, bookingId },
      new AbortController().signal,
    );
    assert.deepEqual(foreignCustomer, { found: false });

    const missing = await reader.getBooking(
      { tenantId, customerId, bookingId: randomUUID() },
      new AbortController().signal,
    );
    assert.deepEqual(missing, { found: false });
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
