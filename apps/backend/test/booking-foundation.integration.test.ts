import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { BookingEngine } from '../src/booking/booking-engine';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('booking foundation enforces resource isolation and buffered overlap exclusion', { timeout: 15000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'booking integration requires MIGRATION_DATABASE_URL');
  const config = parseConfig(process.env);
  const deps = new Dependencies(config);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const customerId = randomUUID();
  const serviceId = randomUUID();
  const engine = new BookingEngine(deps);

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Booking fixture',
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.tenant.create({
      data: {
        id: otherTenantId,
        name: 'Other booking fixture',
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.customer.create({
      data: {
        id: customerId,
        tenantId,
        displayName: 'Booking customer',
        phoneE164: '+351910000099',
      },
    });
    await admin.businessService.create({
      data: {
        id: serviceId,
        tenantId,
        name: 'Booking service',
        slug: `booking-${serviceId}`,
        price: '20.00',
        currency: 'EUR',
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 15,
      },
    });

    const resourceId = await engine.ensureDefaultResource(tenantId, new AbortController().signal);
    assert.equal(
      await engine.ensureDefaultResource(tenantId, new AbortController().signal),
      resourceId,
    );

    const firstId = randomUUID();
    await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRaw`
        INSERT INTO bookings (
          tenant_id, id, customer_id, service_id, resource_id, source, status,
          starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
        ) VALUES (
          ${tenantId}::uuid, ${firstId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'manual', 'confirmed',
          ${new Date('2026-09-15T09:00:00Z')}, ${new Date('2026-09-15T09:30:00Z')}, 0, 15
        )
      `;
    });

    await assert.rejects(
      deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`
          INSERT INTO bookings (
            tenant_id, customer_id, service_id, resource_id, source, status,
            starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
          ) VALUES (
            ${tenantId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
            ${resourceId}::uuid, 'manual', 'pending',
            ${new Date('2026-09-15T09:40:00Z')}, ${new Date('2026-09-15T10:10:00Z')}, 0, 0
          )
        `;
      }),
    );

    await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRaw`
        INSERT INTO bookings (
          tenant_id, customer_id, service_id, resource_id, source, status,
          starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
        ) VALUES (
          ${tenantId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'manual', 'pending',
          ${new Date('2026-09-15T09:45:00Z')}, ${new Date('2026-09-15T10:15:00Z')}, 0, 0
        )
      `;
      await tx.$executeRaw`
        INSERT INTO bookings (
          tenant_id, customer_id, service_id, resource_id, source, status,
          starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
        ) VALUES (
          ${tenantId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'manual', 'cancelled',
          ${new Date('2026-09-15T09:10:00Z')}, ${new Date('2026-09-15T09:20:00Z')}, 0, 0
        )
      `;
    });

    const [counts] = await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return tx.$queryRaw<Array<{ resources: bigint; bookings: bigint }>>`
        SELECT
          (SELECT count(*) FROM booking_resources WHERE tenant_id=${tenantId}::uuid) AS resources,
          (SELECT count(*) FROM bookings WHERE tenant_id=${tenantId}::uuid) AS bookings
      `;
    });
    assert.equal(counts?.resources, 1n);
    assert.equal(counts?.bookings, 3n);

    const [hidden] = await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
      return tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM bookings WHERE tenant_id=${tenantId}::uuid
      `;
    });
    assert.equal(hidden?.count, 0n);
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
