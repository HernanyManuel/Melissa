import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { BookingEngine } from '../src/booking/booking-engine';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'create_booking is fenced, atomic, idempotent and conflict-safe',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'create booking integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const serviceId = randomUUID();
    const engine = new BookingEngine(deps);
    const firstKey = `${turnId}:booking_1`;

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Create booking fixture',
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
          externalAccountId: `${Date.now()}-booking`,
          externalPhoneId: `${Date.now()}4`,
          displayName: 'Booking channel',
          credentialsReference: 'secret://test/whatsapp',
          webhookSecretReference: 'secret://test/webhook',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Booking Customer',
          phoneE164: '+351910000097',
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
          modeEpoch: 13n,
          stateVersion: 6n,
          lastMessageAt: new Date(),
        },
      });
      await admin.$executeRaw`
        INSERT INTO ai_turns (
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
        ) VALUES (
          ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
          ${customerId}::uuid, 13, 6
        )`;
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Create booking service',
          slug: `create-booking-${serviceId}`,
          price: '35.50',
          currency: 'EUR',
          durationMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 15,
        },
      });
      await admin.businessHour.create({
        data: {
          tenantId,
          weekday: 2,
          startTime: '09:00',
          endTime: '11:00',
          enabled: true,
        },
      });

      const first = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 13n,
          idempotencyKey: firstKey,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T09:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(first.status, 'created');
      if (first.status !== 'created') assert.fail('booking should be created');
      assert.equal(first.startsAt, '2026-09-15T08:00:00.000Z');
      assert.equal(first.endsAt, '2026-09-15T08:30:00.000Z');
      assert.equal(first.timezone, 'Europe/Lisbon');
      assert.equal(first.duplicate, false);

      const [booking] = await admin.$queryRaw<
        Array<{
          id: string;
          status: string;
          source: string;
          timezone: string | null;
          duration_minutes: number | null;
          price_snapshot: string | null;
          currency_snapshot: string | null;
        }>
      >`
        SELECT id::text, status, source, timezone, duration_minutes,
          price_snapshot::text, currency_snapshot
        FROM bookings
        WHERE tenant_id=${tenantId}::uuid AND idempotency_key=${firstKey}
      `;
      assert.equal(booking?.id, first.bookingId);
      assert.equal(booking?.status, 'confirmed');
      assert.equal(booking?.source, 'ai');
      assert.equal(booking?.timezone, 'Europe/Lisbon');
      assert.equal(booking?.duration_minutes, 30);
      assert.equal(booking?.price_snapshot, '35.500000');
      assert.equal(booking?.currency_snapshot, 'EUR');
      assert.equal(
        await admin.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM booking_outbox
          WHERE tenant_id=${tenantId}::uuid AND booking_id=${first.bookingId}::uuid
            AND event_type='created'
        `.then((rows) => rows[0]?.count),
        1n,
      );
      assert.equal(
        await admin.auditEvent.count({ where: { tenantId, action: 'ai.booking_created' } }),
        1,
      );

      const replay = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 13n,
          idempotencyKey: firstKey,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T09:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(replay.status, 'created');
      if (replay.status !== 'created') assert.fail('replay should resolve the booking');
      assert.equal(replay.bookingId, first.bookingId);
      assert.equal(replay.duplicate, true);
      assert.equal(
        await admin.auditEvent.count({ where: { tenantId, action: 'ai.booking_created' } }),
        1,
      );

      await assert.rejects(
        engine.createBooking(
          {
            tenantId,
            conversationId,
            customerId,
            turnId,
            expectedModeEpoch: 13n,
            idempotencyKey: firstKey,
            executionMode: 'live',
            serviceId,
            startsAt: '2026-09-15T09:30:00+01:00',
            confirmed: true,
          },
          new AbortController().signal,
        ),
        /Idempotency conflict/,
      );

      const conflict = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 13n,
          idempotencyKey: `${turnId}:booking_conflict`,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T09:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(conflict, { status: 'unavailable' });

      const offGrid = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 13n,
          idempotencyKey: `${turnId}:off_grid`,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T09:07:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(offGrid, { status: 'unavailable' });

      await assert.rejects(
        engine.createBooking(
          {
            tenantId,
            conversationId,
            customerId,
            turnId,
            expectedModeEpoch: 12n,
            idempotencyKey: `${turnId}:stale`,
            executionMode: 'live',
            serviceId,
            startsAt: '2026-09-15T09:45:00+01:00',
            confirmed: true,
          },
          new AbortController().signal,
        ),
        /stale/,
      );
      await assert.rejects(
        engine.createBooking(
          {
            tenantId,
            conversationId,
            customerId,
            turnId,
            expectedModeEpoch: 13n,
            idempotencyKey: `${turnId}:sandbox`,
            executionMode: 'sandbox',
            serviceId,
            startsAt: '2026-09-15T09:45:00+01:00',
            confirmed: true,
          },
          new AbortController().signal,
        ),
        /live-only/,
      );

      const [count] = await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM bookings WHERE tenant_id=${tenantId}::uuid
      `;
      assert.equal(count?.count, 1n);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
