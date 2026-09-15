import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaBookingRescheduler } from '../src/ai/reschedule-booking-tool';
import { BookingEngine } from '../src/booking/booking-engine';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'booking engine inherits and enforces tenant-scoped staff hours across availability and writes',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'staff hours integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const serviceId = randomUUID();
    const staffId = randomUUID();
    const engine = new BookingEngine(deps);
    const rescheduler = new PrismaBookingRescheduler(deps);

    try {
      await admin.tenant.createMany({
        data: [
          {
            id: tenantId,
            name: 'Staff hours fixture',
            countryCode: 'PT',
            timezone: 'Europe/Lisbon',
          },
          {
            id: otherTenantId,
            name: 'Other staff hours fixture',
            countryCode: 'PT',
            timezone: 'Europe/Lisbon',
          },
        ],
      });
      await admin.channelConnection.create({
        data: {
          id: channelId,
          tenantId,
          channelType: 'whatsapp',
          mode: 'live',
          externalAccountId: `${Date.now()}-staff-hours`,
          externalPhoneId: `${Date.now()}6`,
          displayName: 'Staff hours channel',
          credentialsReference: 'secret://test/whatsapp',
          webhookSecretReference: 'secret://test/webhook',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Staff hours customer',
          phoneE164: '+351910000092',
          language: 'pt',
        },
      });
      await admin.conversation.create({
        data: {
          id: conversationId,
          tenantId,
          customerId,
          channelConnectionId: channelId,
          mode: 'AI_ACTIVE',
          modeEpoch: 41n,
          stateVersion: 1n,
          lastMessageAt: new Date(),
        },
      });
      await admin.$executeRaw`
        INSERT INTO ai_turns (
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
        ) VALUES (
          ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
          ${customerId}::uuid, 41, 1
        )
      `;
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Staff hours service',
          slug: `staff-hours-${serviceId}`,
          price: '30.00',
          currency: 'EUR',
          durationMinutes: 30,
        },
      });
      await admin.staff.create({
        data: {
          id: staffId,
          tenantId,
          name: 'Restricted staff',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.staffService.create({
        data: { tenantId, staffId, serviceId, active: true },
      });
      await admin.businessHour.create({
        data: {
          tenantId,
          weekday: 2,
          startTime: '09:00',
          endTime: '13:00',
          enabled: true,
        },
      });

      const inherited = await engine.availableSlots(
        { tenantId, serviceId, staffId, date: '2026-09-15' },
        new AbortController().signal,
      );
      assert.equal(inherited.slots[0]?.startsAt, '2026-09-15T08:00:00.000Z');
      assert.equal(inherited.slots.at(-1)?.startsAt, '2026-09-15T11:30:00.000Z');

      await admin.$executeRaw`
        INSERT INTO staff_hours (tenant_id, staff_id, weekday, start_time, end_time, enabled)
        VALUES (${tenantId}::uuid, ${staffId}::uuid, 2, '10:00', '12:00', true)
      `;

      const restricted = await engine.availableSlots(
        { tenantId, serviceId, staffId, date: '2026-09-15' },
        new AbortController().signal,
      );
      assert.deepEqual(
        restricted.slots.map((slot) => slot.startsAt),
        [
          '2026-09-15T09:00:00.000Z',
          '2026-09-15T09:15:00.000Z',
          '2026-09-15T09:30:00.000Z',
          '2026-09-15T09:45:00.000Z',
          '2026-09-15T10:00:00.000Z',
          '2026-09-15T10:15:00.000Z',
          '2026-09-15T10:30:00.000Z',
        ],
      );

      const outsideCreate = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 41n,
          idempotencyKey: `${turnId}:outside`,
          executionMode: 'live',
          serviceId,
          staffId,
          startsAt: '2026-09-15T09:30:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(outsideCreate, { status: 'unavailable' });

      const created = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 41n,
          idempotencyKey: `${turnId}:inside`,
          executionMode: 'live',
          serviceId,
          staffId,
          startsAt: '2026-09-15T10:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(created.status, 'created');
      if (created.status !== 'created') assert.fail('staff booking should be created');
      assert.equal(created.staffId, staffId);

      const outsideReschedule = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 41n,
          idempotencyKey: `${turnId}:reschedule-outside`,
          executionMode: 'live',
          bookingId: created.bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-15T12:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(outsideReschedule, { status: 'unavailable' });

      const insideReschedule = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 41n,
          idempotencyKey: `${turnId}:reschedule-inside`,
          executionMode: 'live',
          bookingId: created.bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-15T11:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(insideReschedule.status, 'rescheduled');

      const [visible] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM staff_hours WHERE tenant_id=${tenantId}::uuid
        `;
      });
      assert.equal(visible?.count, 1n);

      const [hidden] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM staff_hours WHERE tenant_id=${tenantId}::uuid
        `;
      });
      assert.equal(hidden?.count, 0n);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
