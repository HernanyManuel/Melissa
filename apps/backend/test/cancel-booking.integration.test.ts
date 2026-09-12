import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaBookingCanceller } from '../src/ai/cancel-booking-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test('cancel_booking is fenced, versioned, customer-scoped, atomic and replay-safe', async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'cancel booking integration requires MIGRATION_DATABASE_URL');
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
  const alreadyCancelledId = randomUUID();
  const canceller = new PrismaBookingCanceller(deps);
  const firstKey = `${turnId}:cancel_1`;

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Cancel booking fixture',
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
        externalAccountId: `${Date.now()}-cancel`,
        externalPhoneId: `${Date.now()}8`,
        displayName: 'Cancel booking channel',
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
          phoneE164: '+351910000096',
          language: 'pt',
        },
        {
          id: otherCustomerId,
          tenantId,
          displayName: 'Other customer',
          phoneE164: '+351910000095',
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
          modeEpoch: 21n,
          stateVersion: 4n,
          lastMessageAt: new Date(),
        },
        {
          id: otherConversationId,
          tenantId,
          customerId: otherCustomerId,
          channelConnectionId: channelId,
          mode: 'AI_ACTIVE',
          modeEpoch: 7n,
          stateVersion: 2n,
          lastMessageAt: new Date(),
        },
      ],
    });
    await admin.$executeRaw`
      INSERT INTO ai_turns (
        tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
      ) VALUES
        (${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid, ${customerId}::uuid, 21, 4),
        (${tenantId}::uuid, ${otherTurnId}::uuid, ${otherConversationId}::uuid,
          ${otherCustomerId}::uuid, 7, 2)
    `;
    await admin.businessService.create({
      data: {
        id: serviceId,
        tenantId,
        name: 'Cancellation service',
        slug: `cancel-booking-${serviceId}`,
        price: '20.00',
        currency: 'EUR',
        durationMinutes: 30,
      },
    });
    await admin.$executeRaw`
      INSERT INTO booking_resources (tenant_id, id, kind, name)
      VALUES (${tenantId}::uuid, ${resourceId}::uuid, 'default', 'Cancellation resource')
    `;
    await admin.$executeRaw`
      INSERT INTO bookings (
        tenant_id, id, customer_id, service_id, resource_id, source, status,
        starts_at, ends_at, buffer_before_minutes, buffer_after_minutes, cancelled_at
      ) VALUES
        (${tenantId}::uuid, ${bookingId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
          ${resourceId}::uuid, 'manual', 'confirmed',
          '2026-09-18T08:00:00Z'::timestamptz, '2026-09-18T08:30:00Z'::timestamptz,
          0, 0, NULL),
        (${tenantId}::uuid, ${alreadyCancelledId}::uuid, ${customerId}::uuid,
          ${serviceId}::uuid, ${resourceId}::uuid, 'manual', 'cancelled',
          '2026-09-18T09:00:00Z'::timestamptz, '2026-09-18T09:30:00Z'::timestamptz,
          0, 0, '2026-09-11T12:00:00Z'::timestamptz)
    `;

    const first = await canceller.cancel(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 21n,
        idempotencyKey: firstKey,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        reason: 'Cliente pediu cancelamento',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.equal(first.status, 'cancelled');
    assert.equal(first.bookingId, bookingId);
    assert.equal(first.duplicate, false);
    assert.equal(first.alreadyCancelled, false);

    const [booking] = await admin.$queryRaw<
      Array<{
        status: string;
        cancelled_at: Date | null;
        cancellation_reason: string | null;
        version: number;
      }>
    >`
      SELECT status, cancelled_at, cancellation_reason, version
      FROM bookings
      WHERE tenant_id=${tenantId}::uuid AND id=${bookingId}::uuid
    `;
    assert.equal(booking?.status, 'cancelled');
    assert(booking?.cancelled_at);
    assert.equal(booking?.cancellation_reason, 'Cliente pediu cancelamento');
    assert.equal(booking?.version, 2);
    assert.equal(
      await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM booking_operations
        WHERE tenant_id=${tenantId}::uuid AND booking_id=${bookingId}::uuid AND operation='cancel'
      `.then((rows) => rows[0]?.count),
      1n,
    );
    assert.equal(
      await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM booking_outbox
        WHERE tenant_id=${tenantId}::uuid AND booking_id=${bookingId}::uuid
          AND event_type='cancelled'
      `.then((rows) => rows[0]?.count),
      1n,
    );
    assert.equal(
      await admin.auditEvent.count({ where: { tenantId, action: 'ai.booking_cancelled' } }),
      1,
    );

    const replay = await canceller.cancel(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 21n,
        idempotencyKey: firstKey,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        reason: 'Cliente pediu cancelamento',
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.equal(replay.status, 'cancelled');
    assert.equal(replay.bookingId, bookingId);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.cancelledAt, booking?.cancelled_at?.toISOString());
    assert.equal(
      await admin.auditEvent.count({ where: { tenantId, action: 'ai.booking_cancelled' } }),
      1,
    );

    await assert.rejects(
      canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 21n,
          idempotencyKey: firstKey,
          executionMode: 'live',
          bookingId,
          expectedVersion: 1,
          reason: 'Razão diferente',
          confirmed: true,
        },
        new AbortController().signal,
      ),
      /Idempotency conflict/,
    );

    const staleVersion = await canceller.cancel(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 21n,
        idempotencyKey: `${turnId}:stale-version`,
        executionMode: 'live',
        bookingId,
        expectedVersion: 1,
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(staleVersion, { status: 'stale' });

    const foreign = await canceller.cancel(
      {
        tenantId,
        conversationId: otherConversationId,
        customerId: otherCustomerId,
        turnId: otherTurnId,
        expectedModeEpoch: 7n,
        idempotencyKey: `${otherTurnId}:foreign`,
        executionMode: 'live',
        bookingId,
        expectedVersion: 2,
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(foreign, { status: 'not_found' });

    await assert.rejects(
      canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 20n,
          idempotencyKey: `${turnId}:stale-epoch`,
          executionMode: 'live',
          bookingId: alreadyCancelledId,
          expectedVersion: 1,
          confirmed: true,
        },
        new AbortController().signal,
      ),
      /stale/,
    );
    await assert.rejects(
      canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 21n,
          idempotencyKey: `${turnId}:sandbox`,
          executionMode: 'sandbox',
          bookingId: alreadyCancelledId,
          expectedVersion: 1,
          confirmed: true,
        },
        new AbortController().signal,
      ),
      /live-only/,
    );

    const alreadyCancelled = await canceller.cancel(
      {
        tenantId,
        conversationId,
        customerId,
        turnId,
        expectedModeEpoch: 21n,
        idempotencyKey: `${turnId}:already`,
        executionMode: 'live',
        bookingId: alreadyCancelledId,
        expectedVersion: 1,
        confirmed: true,
      },
      new AbortController().signal,
    );
    assert.equal(alreadyCancelled.status, 'cancelled');
    assert.equal(alreadyCancelled.alreadyCancelled, true);
    assert.equal(
      await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM booking_operations
        WHERE tenant_id=${tenantId}::uuid AND booking_id=${alreadyCancelledId}::uuid
      `.then((rows) => rows[0]?.count),
      0n,
    );
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
