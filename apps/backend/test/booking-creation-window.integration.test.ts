import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { BookingEngine } from '../src/booking/booking-engine';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'creation window filters availability and transactionally denies out-of-policy bookings',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'creation window integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const serviceId = randomUUID();
    const engine = new BookingEngine(deps);

    try {
      const [clock] = await admin.$queryRaw<
        Array<{
          near_at: Date;
          allowed_at: Date;
          far_at: Date;
          near_date: string;
          allowed_date: string;
          far_date: string;
        }>
      >`
        SELECT
          date_trunc('hour', CURRENT_TIMESTAMP) + interval '1 hour' AS near_at,
          date_trunc('hour', CURRENT_TIMESTAMP) + interval '4 hours' AS allowed_at,
          date_trunc('hour', CURRENT_TIMESTAMP) + interval '2 days 4 hours' AS far_at,
          to_char(date_trunc('hour', CURRENT_TIMESTAMP) + interval '1 hour', 'YYYY-MM-DD') AS near_date,
          to_char(date_trunc('hour', CURRENT_TIMESTAMP) + interval '4 hours', 'YYYY-MM-DD') AS allowed_date,
          to_char(date_trunc('hour', CURRENT_TIMESTAMP) + interval '2 days 4 hours', 'YYYY-MM-DD') AS far_date
      `;
      assert(clock, 'database clock fixture should resolve');

      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Creation window fixture',
          countryCode: 'PT',
          timezone: 'UTC',
        },
      });
      await admin.channelConnection.create({
        data: {
          id: channelId,
          tenantId,
          channelType: 'whatsapp',
          mode: 'live',
          externalAccountId: `${Date.now()}-creation-window`,
          externalPhoneId: `${Date.now()}9`,
          displayName: 'Creation window channel',
          credentialsReference: 'secret://test/whatsapp',
          webhookSecretReference: 'secret://test/webhook',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Creation window customer',
          phoneE164: '+351910000089',
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
          modeEpoch: 61n,
          stateVersion: 1n,
          lastMessageAt: new Date(),
        },
      });
      await admin.$executeRaw`
        INSERT INTO ai_turns (
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
        ) VALUES (
          ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
          ${customerId}::uuid, 61, 1
        )
      `;
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Creation window service',
          slug: `creation-window-${serviceId}`,
          price: '30.00',
          currency: 'EUR',
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
        },
      });
      await admin.businessHour.createMany({
        data: Array.from({ length: 7 }, (_, index) => ({
          tenantId,
          weekday: index + 1,
          startTime: '00:00',
          endTime: '23:59',
          enabled: true,
        })),
      });
      await admin.$executeRaw`
        INSERT INTO booking_policies (
          tenant_id, creation_min_notice_minutes, creation_max_horizon_days
        ) VALUES (${tenantId}::uuid, 120, 1)
        ON CONFLICT (tenant_id) DO UPDATE SET
          creation_min_notice_minutes=EXCLUDED.creation_min_notice_minutes,
          creation_max_horizon_days=EXCLUDED.creation_max_horizon_days,
          version=booking_policies.version+1,
          updated_at=CURRENT_TIMESTAMP
      `;

      const nearAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: clock.near_date },
        new AbortController().signal,
      );
      assert(!nearAvailability.slots.some((slot) => slot.startsAt === clock.near_at.toISOString()));

      const allowedAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: clock.allowed_date },
        new AbortController().signal,
      );
      assert(
        allowedAvailability.slots.some((slot) => slot.startsAt === clock.allowed_at.toISOString()),
      );

      const farAvailability = await engine.availableSlots(
        { tenantId, serviceId, date: clock.far_date },
        new AbortController().signal,
      );
      assert.deepEqual(farAvailability.slots, []);

      const nearDenied = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 61n,
          idempotencyKey: `${turnId}:near`,
          executionMode: 'live',
          serviceId,
          startsAt: clock.near_at.toISOString(),
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(nearDenied, {
        status: 'policy_denied',
        reason: 'minimum_notice',
        minimumNoticeMinutes: 120,
        maximumHorizonDays: 1,
      });

      const farDenied = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 61n,
          idempotencyKey: `${turnId}:far`,
          executionMode: 'live',
          serviceId,
          startsAt: clock.far_at.toISOString(),
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(farDenied, {
        status: 'policy_denied',
        reason: 'maximum_horizon',
        minimumNoticeMinutes: 120,
        maximumHorizonDays: 1,
      });

      const [beforeAllowed] = await admin.$queryRaw<Array<{ bookings: bigint; audits: bigint }>>`
        SELECT
          (SELECT count(*) FROM bookings WHERE tenant_id=${tenantId}::uuid) AS bookings,
          (SELECT count(*) FROM audit_events
            WHERE tenant_id=${tenantId}::uuid AND action='ai.booking_created') AS audits
      `;
      assert.equal(beforeAllowed?.bookings, 0n);
      assert.equal(beforeAllowed?.audits, 0n);

      const created = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 61n,
          idempotencyKey: `${turnId}:allowed`,
          executionMode: 'live',
          serviceId,
          startsAt: clock.allowed_at.toISOString(),
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(created.status, 'created');
      if (created.status !== 'created') assert.fail('in-window booking should be created');

      await admin.$executeRaw`
        UPDATE booking_policies
        SET creation_min_notice_minutes=525600,
          creation_max_horizon_days=0,
          version=version+1,
          updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const replay = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 999n,
          idempotencyKey: `${turnId}:allowed`,
          executionMode: 'live',
          serviceId,
          startsAt: clock.allowed_at.toISOString(),
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(replay.status, 'created');
      if (replay.status !== 'created') assert.fail('exact replay should ignore current creation policy');
      assert.equal(replay.bookingId, created.bookingId);
      assert.equal(replay.duplicate, true);

      const [afterReplay] = await admin.$queryRaw<
        Array<{ bookings: bigint; outbox: bigint; audits: bigint }>
      >`
        SELECT
          (SELECT count(*) FROM bookings WHERE tenant_id=${tenantId}::uuid) AS bookings,
          (SELECT count(*) FROM booking_outbox
            WHERE tenant_id=${tenantId}::uuid AND event_type='created') AS outbox,
          (SELECT count(*) FROM audit_events
            WHERE tenant_id=${tenantId}::uuid AND action='ai.booking_created') AS audits
      `;
      assert.equal(afterReplay?.bookings, 1n);
      assert.equal(afterReplay?.outbox, 1n);
      assert.equal(afterReplay?.audits, 1n);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
