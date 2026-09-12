import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { BookingEngine } from '../src/booking/booking-engine';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'booking foundation enforces resources, buffered exclusion and timezone-aware availability',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'booking integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const customerId = randomUUID();
    const serviceId = randomUUID();
    const staffId = randomUUID();
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
      await admin.staff.create({
        data: {
          id: staffId,
          tenantId,
          name: 'Booking staff',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.staffService.create({
        data: {
          tenantId,
          staffId,
          serviceId,
          active: true,
          customDurationMinutes: 45,
        },
      });
      await admin.businessHour.createMany({
        data: [
          { tenantId, weekday: 2, startTime: '09:00', endTime: '11:00', enabled: true },
          { tenantId, weekday: 3, startTime: '09:00', endTime: '11:00', enabled: true },
        ],
      });
      await admin.scheduleException.create({
        data: {
          tenantId,
          date: new Date('2026-09-16T00:00:00Z'),
          closed: true,
          reason: 'Closed fixture',
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
            starts_at, ends_at, buffer_before_minutes, buffer_after_minutes, cancelled_at
          ) VALUES (
            ${tenantId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
            ${resourceId}::uuid, 'manual', 'cancelled',
            ${new Date('2026-09-15T09:10:00Z')}, ${new Date('2026-09-15T09:20:00Z')}, 0, 0,
            ${new Date('2026-09-15T08:00:00Z')}
          )
        `;
      });

      const defaultAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: '2026-09-15' },
        new AbortController().signal,
      );
      assert.equal(defaultAvailability.timezone, 'Europe/Lisbon');
      assert.equal(defaultAvailability.resourceId, resourceId);
      assert.equal(defaultAvailability.staffId, null);
      assert.deepEqual(
        defaultAvailability.slots.map((slot) => slot.startsAt),
        ['2026-09-15T08:00:00.000Z', '2026-09-15T08:15:00.000Z'],
      );

      const staffAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: '2026-09-15', staffId },
        new AbortController().signal,
      );
      assert.equal(staffAvailability.staffId, staffId);
      assert.notEqual(staffAvailability.resourceId, resourceId);
      assert.equal(staffAvailability.slots[0]?.startsAt, '2026-09-15T08:00:00.000Z');
      assert.equal(staffAvailability.slots[0]?.endsAt, '2026-09-15T08:45:00.000Z');

      const closedAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: '2026-09-16' },
        new AbortController().signal,
      );
      assert.deepEqual(closedAvailability.slots, []);
      await assert.rejects(
        engine.availableSlots(
          { tenantId, serviceId, date: '2026-02-31' },
          new AbortController().signal,
        ),
        /Invalid booking date/,
      );

      const [counts] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ resources: bigint; bookings: bigint }>>`
          SELECT
            (SELECT count(*) FROM booking_resources WHERE tenant_id=${tenantId}::uuid) AS resources,
            (SELECT count(*) FROM bookings WHERE tenant_id=${tenantId}::uuid) AS bookings
        `;
      });
      assert.equal(counts?.resources, 2n);
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
  },
);
