import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaBookingRescheduler } from '../src/ai/reschedule-booking-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('reschedule_booking is fenced, versioned, customer-scoped, conflict-safe and replay-safe', async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'reschedule booking integration requires MIGRATION_DATABASE_URL');
  const deps = new Dependencies(parseConfig(process.env));
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const channelId = randomUUID();
  const customerId = randomUUID();
  const otherCustomerId = randomUUID();
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  const turnId = randomUUID();
  const otherTurnId = randomUUID();
  const serviceId = randomUUID();
  const resourceId = randomUUID();
  const bookingId = randomUUID();
  const blockerId = randomUUID();
  const rescheduler = new PrismaBookingRescheduler(deps);
  const firstKey = `${turnId}:reschedule_1`;

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Reschedule booking fixture',
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
        externalAccountId: `${Date.now()}-reschedule`,
        externalPhoneId: `${Date.now()}7`,
        displayName: 'Reschedule booking channel',
        credentialsReference: 'secret://test/whatsapp',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.customer.createMany({
      data: [
        {
          id: customerId,
          tenantId,
          displayName: 'Booking owner',
          phoneE164: '+351910000094',
          language: 'pt',
        },
        {
          id: otherCustomerId,
          tenantId,
          displayName: 'Other customer',
          phoneE164: '+351910000093',
          language: 'pt',
        },
      ],
    });
    await admin.conversation.createMany({
      data: [
        {
          id: conversationId,
          tenantId,
          customerId,
          channelConnectionId: channelId,
          mode: 'AI_ACTIVE',
          modeEpoch: 31n,
          stateVersion: 5n,
          lastMessageAt: new Date(),
        },
        {
          id: otherConversationId,
          tenantId,
          customerId: otherCustomerId,
          channelConnectionId: channelId,
          mode: 'AI_ACTIVE',
          modeEpoch: 8n,
          stateVersion: 3n,
          lastMessageAt: new Date(),
        },
      ],
    });
    await admin.$executeRaw`
      INSERT INTO ai_turns (
        tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
      ) VALUES
        (${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid, ${customerId}::uuid, 31, 5),
        (${tenantId}::uuid, ${otherTurnId}::uuid, ${otherConversationId}::uuid,
          ${otherCustomerId}::uuid, 8, 3)
    `;
    await admin.businessService.create({
      data: {
        id: serviceId,
        tenantId,
        name: 'Reschedule service',
        slug: `reschedule-booking-${serviceId}`,
        price: '25.00',
        currency: 'EUR',
        durationMinutes: 30,
      },
    });
    await admin.businessHour.create({
      data: { tenantId, weekday: 5, startTime: '09:00', endTime: '13:00', enabled: true },
    });
    await admin.$executeRaw`
      INSERT INTO booking_resources (tenant_id, id, kind, name)
      VALUES (${tenantId}::uuid, ${resourceId}::uuid, 'default', 'Reschedule resource')
    `;
    await admin.$executeRaw`
      INSERT INTO bookings (
        tenant_id, id, customer_id, service_id, resource_id, source, status,
        starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
      ) VALUES
        (${tenantId}::uuid, ${bookingId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'manual', 'confirmed',
          '2026-09-18T08:00:00Z'::timestamptz, '2026-09-18T08:30:00Z'::timestamptz, 0, 0),
        (${tenantId}::uuid, ${blockerId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'manual', 'confirmed',
          '2026-09-18T10:00:00Z'::timestamptz, '2026-09-18T10:30:00Z'::timestamptz, 0, 0)
    `;

    const first = await rescheduler.reschedule(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 31n,
        idempotencyKey: firstKey,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        startsAt: '2026-09-18T09:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(first, {
      status: 'rescheduled',
      bookingId,
      startsAt: '2026-09-18T09:00:00.000Z',
      endsAt: '2026-09-18T09:30:00.000Z',
      timezone: 'Europe/Lisbon',
      duplicate: false,
    });

    const replay = await rescheduler.reschedule(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 31n,
        idempotencyKey: firstKey,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        startsAt: '2026-09-18T09:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(replay, { ...first, duplicate: true });

    await assert.rejects(
      rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 31n,
          idempotencyKey: firstKey,
          executionMode: 'live',
          bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-18T11:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      ),
      /Idempotency conflict/,
    );

    const staleVersion = await rescheduler.reschedule(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 31n,
        idempotencyKey: `${turnId}:stale-version`,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        startsAt: '2026-09-18T11:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(staleVersion, { status: 'stale' });

    const foreign = await rescheduler.reschedule(
      {
        tenantId,
        conversationId: otherConversationId,
        customerId: otherCustomerId,
        turnId: otherTurnId,
        expectedModeEpoch: 8n,
        idempotencyKey: `${otherTurnId}:foreign`,
        executionMode: 'live',
        bookingId,
        expectedVersion: 2,
        startsAt: '2026-09-18T11:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(foreign, { status: 'not_found' });

    const conflict = await rescheduler.reschedule(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 31n,
        idempotencyKey: `${turnId}:conflict`,
        executionMode: 'live',
        bookingId,
        expectedVersion: 2,
        startsAt: '2026-09-18T10:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(conflict, { status: 'unavailable' });

    const second = await rescheduler.reschedule(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 31n,
        idempotencyKey: `${turnId}:reschedule_2`,
        executionMode: 'live',
        bookingId,
        expectedVersion: 2,
        startsAt: '2026-09-18T11:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.equal(second.status, 'rescheduled');
    assert.equal(second.duplicate, false);

    const oldReplayAfterSecond = await rescheduler.reschedule(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 31n,
        idempotencyKey: firstKey,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        startsAt: '2026-09-18T09:00:00Z',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(oldReplayAfterSecond, { ...first, duplicate: true });

    const [booking] = await admin.$queryRaw<
      Array<{ starts_at: Date; ends_at: Date; version: number }>
    >`
      SELECT starts_at, ends_at, version
      FROM bookings
      WHERE tenant_id=${tenantId}::uuid AND id=${bookingId}::uuid
    `;
    assert.equal(booking?.starts_at.toISOString(), '2026-09-18T11:00:00.000Z');
    assert.equal(booking?.ends_at.toISOString(), '2026-09-18T11:30:00.000Z');
    assert.equal(booking?.version, 3);
    assert.equal(
      await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM booking_operations
        WHERE tenant_id=${tenantId}::uuid AND booking_id=${bookingId}::uuid AND operation='reschedule'
      `.then((rows) => rows[0]?.count),
      2n,
    );
    assert.equal(
      await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM booking_outbox
        WHERE tenant_id=${tenantId}::uuid AND booking_id=${bookingId}::uuid
          AND event_type='rescheduled'
      `.then((rows) => rows[0]?.count),
      2n,
    );
    assert.equal(
      await admin.auditEvent.count({ where: { tenantId, action: 'ai.booking_rescheduled' } }),
      2,
    );

    await assert.rejects(
      rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 30n,
          idempotencyKey: `${turnId}:stale-epoch`,
          executionMode: 'live',
          bookingId,
          expectedVersion: 3,
          startsAt: '2026-09-18T09:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      ),
      /stale/,
    );
    await assert.rejects(
      rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 31n,
          idempotencyKey: `${turnId}:sandbox`,
          executionMode: 'sandbox',
          bookingId,
          expectedVersion: 3,
          startsAt: '2026-09-18T09:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      ),
      /live-only/,
    );
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
