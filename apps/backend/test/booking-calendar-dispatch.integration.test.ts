import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { BookingCalendarDispatchStore } from '../src/calendar/booking-calendar-dispatch-store';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'booking calendar dispatch discovery is minimal and claim is tenant-scoped',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'calendar dispatch integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const store = new BookingCalendarDispatchStore(deps);
    const tenantId = randomUUID();
    const bookingId = randomUUID();
    const outboxId = randomUUID();

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Calendar dispatch fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.$executeRaw`
        INSERT INTO customers (tenant_id, id, phone_e164)
        VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, '+351910000001')
      `;
      const [customer] = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM customers WHERE tenant_id=${tenantId}::uuid LIMIT 1
      `;
      assert(customer);
      await admin.$executeRaw`
        INSERT INTO bookings (
          tenant_id, id, customer_id, status, starts_at, ends_at, timezone, version
        ) VALUES (
          ${tenantId}::uuid, ${bookingId}::uuid, ${customer.id}::uuid, 'confirmed',
          '2037-09-15T09:00:00Z'::timestamptz, '2037-09-15T10:00:00Z'::timestamptz,
          'Europe/Lisbon', 1
        )
      `;
      await admin.$executeRaw`
        INSERT INTO booking_outbox
          (tenant_id, id, booking_id, event_type, booking_version)
        VALUES (${tenantId}::uuid, ${outboxId}::uuid, ${bookingId}::uuid, 'created', 1)
      `;
      await admin.$executeRaw`
        INSERT INTO booking_calendar_dispatch (tenant_id, id)
        VALUES (${tenantId}::uuid, ${outboxId}::uuid)
      `;

      assert.deepEqual(await store.due(10), [{ id: outboxId, attempt: 0 }]);
      assert.equal(await store.claim(outboxId, 1), null);
      assert.deepEqual(await store.claim(outboxId, 0), {
        id: outboxId,
        tenantId,
        bookingId,
        eventType: 'created',
        bookingVersion: 1,
        attempt: 0,
      });

      await admin.$executeRaw`
        UPDATE booking_calendar_dispatch
        SET next_attempt_at=CURRENT_TIMESTAMP + interval '1 hour'
        WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      assert.deepEqual(await store.due(10), []);
      assert.equal(await store.claim(outboxId, 0), null);
    } finally {
      await admin.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
      await deps.db.$disconnect();
      await deps.redis.quit();
      await admin.$disconnect();
    }
  },
);
