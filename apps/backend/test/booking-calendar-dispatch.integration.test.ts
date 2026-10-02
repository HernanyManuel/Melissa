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
    const serviceId = randomUUID();
    const resourceId = randomUUID();
    const staffId = randomUUID();
    const connectionId = randomUUID();
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
        INSERT INTO customers (tenant_id, id, display_name, phone_e164, updated_at)
        VALUES (
          ${tenantId}::uuid, ${randomUUID()}::uuid, 'Calendar fixture',
          '+351910000001', CURRENT_TIMESTAMP
        )
      `;
      const [customer] = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM customers WHERE tenant_id=${tenantId}::uuid LIMIT 1
      `;
      assert(customer);
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Calendar dispatch service',
          slug: `calendar-dispatch-${serviceId}`,
          price: '20.00',
          currency: 'EUR',
          durationMinutes: 60,
        },
      });
      await admin.$executeRaw`
        INSERT INTO booking_resources (tenant_id, id, kind, name)
        VALUES (${tenantId}::uuid, ${resourceId}::uuid, 'default', 'Calendar fixture')
      `;
      await admin.$executeRaw`
        INSERT INTO bookings (
          tenant_id, id, customer_id, service_id, resource_id, status,
          starts_at, ends_at, version
        ) VALUES (
          ${tenantId}::uuid, ${bookingId}::uuid, ${customer.id}::uuid,
          ${serviceId}::uuid, ${resourceId}::uuid, 'confirmed',
          '2037-09-15T09:00:00Z'::timestamptz, '2037-09-15T10:00:00Z'::timestamptz, 1
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
      assert.equal(await store.claim(outboxId, 0), null);

      await admin.staff.create({
        data: {
          id: staffId,
          tenantId,
          name: 'Calendar dispatch staff',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.$executeRaw`
        UPDATE booking_resources
        SET kind='staff', staff_id=${staffId}::uuid
        WHERE tenant_id=${tenantId}::uuid AND id=${resourceId}::uuid
      `;
      await admin.$executeRaw`
        INSERT INTO calendar_connections (
          tenant_id, id, staff_id, provider, calendar_ref, status
        ) VALUES (
          ${tenantId}::uuid, ${connectionId}::uuid, ${staffId}::uuid,
          'mock', 'mock:dispatch', 'connected'
        )
      `;
      assert.deepEqual(await store.claim(outboxId, 0), {
        id: outboxId,
        tenantId,
        bookingId,
        eventType: 'created',
        bookingVersion: 1,
        connectionId,
        attempt: 0,
      });

      const ambiguousConnectionId = randomUUID();
      await admin.$executeRaw`
        INSERT INTO calendar_connections (
          tenant_id, id, staff_id, provider, calendar_ref, status
        ) VALUES (
          ${tenantId}::uuid, ${ambiguousConnectionId}::uuid, ${staffId}::uuid,
          'mock', 'mock:dispatch-ambiguous', 'connected'
        )
      `;
      assert.equal(await store.claim(outboxId, 0), null);
      await admin.$executeRaw`
        UPDATE calendar_connections SET status='disconnected'
        WHERE tenant_id=${tenantId}::uuid AND id=${ambiguousConnectionId}::uuid
      `;

      await admin.$executeRaw`
        UPDATE booking_calendar_dispatch
        SET next_attempt_at=CURRENT_TIMESTAMP + interval '1 hour'
        WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      assert.deepEqual(await store.due(10), []);
      assert.equal(await store.claim(outboxId, 0), null);

      await admin.$executeRaw`
        UPDATE booking_calendar_dispatch
        SET next_attempt_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      const claim = await store.claim(outboxId, 0);
      assert(claim);
      await store.recordFailure(claim);
      assert.equal(await store.claim(outboxId, 0), null);

      const [retry] = await admin.$queryRaw<Array<{ attempts: number; state: string }>>`
        SELECT attempts, state
        FROM booking_calendar_dispatch
        WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      assert.deepEqual(retry, { attempts: 1, state: 'pending' });

      await admin.$executeRaw`
        UPDATE booking_calendar_dispatch
        SET attempts=4, next_attempt_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      await admin.$executeRaw`
        UPDATE booking_outbox
        SET attempts=4, next_attempt_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid AND id=${outboxId}::uuid
      `;
      const terminalClaim = await store.claim(outboxId, 4);
      assert(terminalClaim);
      await store.recordFailure(terminalClaim);

      const [terminal] = await admin.$queryRaw<
        Array<{ dispatchState: string; outboxState: string; attempts: number }>
      >`
        SELECT dispatch.state AS "dispatchState", outbox.state AS "outboxState",
          dispatch.attempts
        FROM booking_calendar_dispatch dispatch
        JOIN booking_outbox outbox
          ON outbox.tenant_id=dispatch.tenant_id AND outbox.id=dispatch.id
        WHERE dispatch.tenant_id=${tenantId}::uuid AND dispatch.id=${outboxId}::uuid
      `;
      assert.deepEqual(terminal, {
        dispatchState: 'failed',
        outboxState: 'failed',
        attempts: 5,
      });

      const acceptedOutboxId = randomUUID();
      await admin.$executeRaw`
        INSERT INTO booking_outbox
          (tenant_id, id, booking_id, event_type, booking_version)
        VALUES (
          ${tenantId}::uuid, ${acceptedOutboxId}::uuid, ${bookingId}::uuid,
          'rescheduled', 2
        )
      `;
      await admin.$executeRaw`
        INSERT INTO booking_calendar_dispatch (tenant_id, id)
        VALUES (${tenantId}::uuid, ${acceptedOutboxId}::uuid)
      `;
      const acceptedClaim = await store.claim(acceptedOutboxId, 0);
      assert(acceptedClaim);
      await store.accept(acceptedClaim);

      const [accepted] = await admin.$queryRaw<
        Array<{ dispatchState: string; outboxState: string; processedAt: Date | null }>
      >`
        SELECT dispatch.state AS "dispatchState", outbox.state AS "outboxState",
          outbox.processed_at AS "processedAt"
        FROM booking_calendar_dispatch dispatch
        JOIN booking_outbox outbox
          ON outbox.tenant_id=dispatch.tenant_id AND outbox.id=dispatch.id
        WHERE dispatch.tenant_id=${tenantId}::uuid
          AND dispatch.id=${acceptedOutboxId}::uuid
      `;
      assert.equal(accepted?.dispatchState, 'processed');
      assert.equal(accepted?.outboxState, 'processed');
      assert(accepted?.processedAt instanceof Date);
      assert.equal(await store.claim(acceptedOutboxId, 0), null);
    } finally {
      await admin.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
      await deps.db.$disconnect();
      await deps.redis.quit();
      await admin.$disconnect();
    }
  },
);
