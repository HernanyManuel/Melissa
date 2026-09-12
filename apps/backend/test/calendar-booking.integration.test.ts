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
  'external calendar busy and freshness gate availability, create and reschedule',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'calendar booking integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const serviceId = randomUUID();
    const connectionId = randomUUID();
    const busyId = randomUUID();
    const engine = new BookingEngine(deps);
    const rescheduler = new PrismaBookingRescheduler(deps);

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Calendar booking fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.channelConnection.create({
        data: {
          id: channelId,
          tenantId,
          channelType: 'whatsapp',
          mode: 'live',
          externalAccountId: `${Date.now()}-calendar-booking`,
          externalPhoneId: `${Date.now()}9`,
          displayName: 'Calendar booking channel',
          credentialsReference: 'secret://test/whatsapp',
          webhookSecretReference: 'secret://test/webhook',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Calendar booking customer',
          phoneE164: '+351910000091',
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
          modeEpoch: 51n,
          stateVersion: 4n,
          lastMessageAt: new Date(),
        },
      });
      await admin.$executeRaw`
        INSERT INTO ai_turns (
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
        ) VALUES (
          ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
          ${customerId}::uuid, 51, 4
        )
      `;
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Calendar booking service',
          slug: `calendar-booking-${serviceId}`,
          price: '30.00',
          currency: 'EUR',
          durationMinutes: 30,
        },
      });
      await admin.businessHour.create({
        data: {
          tenantId,
          weekday: 2,
          startTime: '09:00',
          endTime: '12:00',
          enabled: true,
        },
      });
      await admin.$executeRaw`
        INSERT INTO calendar_connections (
          tenant_id, id, provider, calendar_ref, status, sync_version,
          last_success_at, freshness_limit_seconds
        ) VALUES (
          ${tenantId}::uuid, ${connectionId}::uuid, 'mock', 'mock:booking-gate',
          'connected', 1, CURRENT_TIMESTAMP, 60
        )
      `;
      await admin.$executeRaw`
        INSERT INTO calendar_busy_intervals (
          tenant_id, connection_id, id, starts_at, ends_at, sync_version, observed_at
        ) VALUES (
          ${tenantId}::uuid, ${connectionId}::uuid, ${busyId}::uuid,
          '2026-09-15T09:00:00Z'::timestamptz,
          '2026-09-15T09:30:00Z'::timestamptz,
          1, CURRENT_TIMESTAMP
        )
      `;

      const availability = await engine.availableSlots(
        { tenantId, serviceId, date: '2026-09-15' },
        new AbortController().signal,
      );
      assert.equal(availability.staffId, null);
      assert(availability.slots.some((slot) => slot.startsAt === '2026-09-15T08:00:00.000Z'));
      assert(!availability.slots.some((slot) => slot.startsAt === '2026-09-15T09:00:00.000Z'));

      const blockedCreate = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:external-busy`,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T10:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(blockedCreate, { status: 'unavailable' });

      const created = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:external-free`,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T09:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(created.status, 'created');
      if (created.status !== 'created') assert.fail('free external slot should create booking');

      const blockedReschedule = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:reschedule-external-busy`,
          executionMode: 'live',
          bookingId: created.bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-15T10:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(blockedReschedule, { status: 'unavailable' });

      await admin.$executeRaw`
        UPDATE calendar_connections
        SET last_success_at=CURRENT_TIMESTAMP - interval '61 seconds',
          updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid AND id=${connectionId}::uuid
      `;

      const staleAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: '2026-09-15' },
        new AbortController().signal,
      );
      assert.deepEqual(staleAvailability.slots, []);

      const staleCreate = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:external-stale`,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T11:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(staleCreate, { status: 'unavailable' });

      const staleReschedule = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:reschedule-external-stale`,
          executionMode: 'live',
          bookingId: created.bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-15T11:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(staleReschedule, { status: 'unavailable' });
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
