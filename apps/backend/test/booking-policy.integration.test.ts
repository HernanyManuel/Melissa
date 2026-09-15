import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaBookingCanceller } from '../src/ai/cancel-booking-tool';
import { PrismaBookingRescheduler } from '../src/ai/reschedule-booking-tool';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'structured booking policies deny without effects and preserve exact replay across policy changes',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'booking policy integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const serviceId = randomUUID();
    const resourceId = randomUUID();
    const cancelDeniedId = randomUUID();
    const cancelReplayId = randomUUID();
    const rescheduleId = randomUUID();
    const canceller = new PrismaBookingCanceller(deps);
    const rescheduler = new PrismaBookingRescheduler(deps);

    try {
      await admin.tenant.createMany({
        data: [
          {
            id: tenantId,
            name: 'Booking policy fixture',
            countryCode: 'PT',
            timezone: 'Europe/Lisbon',
          },
          {
            id: otherTenantId,
            name: 'Other booking policy fixture',
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
          externalAccountId: `${Date.now()}-booking-policy`,
          externalPhoneId: `${Date.now()}5`,
          displayName: 'Booking policy channel',
          credentialsReference: 'secret://test/whatsapp',
          webhookSecretReference: 'secret://test/webhook',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Booking policy customer',
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
          stateVersion: 1n,
          lastMessageAt: new Date(),
        },
      });
      await admin.$executeRaw`
        INSERT INTO ai_turns (
          tenant_id, id, conversation_id, customer_id, mode_epoch, state_version
        ) VALUES (
          ${tenantId}::uuid, ${turnId}::uuid, ${conversationId}::uuid,
          ${customerId}::uuid, 51, 1
        )
      `;
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Booking policy service',
          slug: `booking-policy-${serviceId}`,
          price: '40.00',
          currency: 'EUR',
          durationMinutes: 30,
        },
      });
      await admin.businessHour.create({
        data: {
          tenantId,
          weekday: 3,
          startTime: '09:00',
          endTime: '17:00',
          enabled: true,
        },
      });
      await admin.$executeRaw`
        INSERT INTO booking_resources (tenant_id, id, kind, name)
        VALUES (${tenantId}::uuid, ${resourceId}::uuid, 'default', 'Policy resource')
      `;
      await admin.$executeRaw`
        INSERT INTO booking_policies (
          tenant_id, cancellation_enabled, cancellation_min_notice_minutes,
          rescheduling_enabled, rescheduling_min_notice_minutes
        ) VALUES (${tenantId}::uuid, false, 0, false, 0)
      `;
      await admin.$executeRaw`
        INSERT INTO bookings (
          tenant_id, id, customer_id, service_id, resource_id, source, status,
          starts_at, ends_at, buffer_before_minutes, buffer_after_minutes, timezone
        ) VALUES
          (${tenantId}::uuid, ${cancelDeniedId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
            ${resourceId}::uuid, 'manual', 'confirmed',
            '2026-09-22T12:00:00Z'::timestamptz, '2026-09-22T12:30:00Z'::timestamptz,
            0, 0, 'Europe/Lisbon'),
          (${tenantId}::uuid, ${cancelReplayId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
            ${resourceId}::uuid, 'manual', 'confirmed',
            '2026-09-24T12:00:00Z'::timestamptz, '2026-09-24T12:30:00Z'::timestamptz,
            0, 0, 'Europe/Lisbon'),
          (${tenantId}::uuid, ${rescheduleId}::uuid, ${customerId}::uuid, ${serviceId}::uuid,
            ${resourceId}::uuid, 'manual', 'confirmed',
            '2026-09-23T09:00:00Z'::timestamptz, '2026-09-23T09:30:00Z'::timestamptz,
            0, 0, 'Europe/Lisbon')
      `;

      const cancelDisabled = await canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:cancel-disabled`,
          executionMode: 'live',
          bookingId: cancelDeniedId,
          expectedVersion: 1,
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(cancelDisabled, {
        status: 'policy_denied',
        reason: 'disabled',
        minimumNoticeMinutes: 0,
      });

      await admin.$executeRaw`
        UPDATE booking_policies
        SET cancellation_enabled=true, cancellation_min_notice_minutes=525600,
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const cancelNotice = await canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:cancel-notice`,
          executionMode: 'live',
          bookingId: cancelDeniedId,
          expectedVersion: 1,
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(cancelNotice, {
        status: 'policy_denied',
        reason: 'minimum_notice',
        minimumNoticeMinutes: 525600,
      });

      const [deniedBooking] = await admin.$queryRaw<
        Array<{ status: string; version: number; cancelled_at: Date | null }>
      >`
        SELECT status, version, cancelled_at
        FROM bookings
        WHERE tenant_id=${tenantId}::uuid AND id=${cancelDeniedId}::uuid
      `;
      assert.deepEqual(deniedBooking, { status: 'confirmed', version: 1, cancelled_at: null });
      assert.equal(
        await admin.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM booking_operations
          WHERE tenant_id=${tenantId}::uuid AND booking_id=${cancelDeniedId}::uuid
        `.then((rows) => rows[0]?.count),
        0n,
      );
      assert.equal(
        await admin.auditEvent.count({
          where: { tenantId, targetId: cancelDeniedId, action: 'ai.booking_cancelled' },
        }),
        0,
      );

      await admin.$executeRaw`
        UPDATE booking_policies
        SET cancellation_enabled=true, cancellation_min_notice_minutes=0,
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const cancelKey = `${turnId}:cancel-replay`;
      const cancelled = await canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: cancelKey,
          executionMode: 'live',
          bookingId: cancelReplayId,
          expectedVersion: 1,
          reason: 'Policy replay fixture',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(cancelled.status, 'cancelled');
      if (cancelled.status !== 'cancelled') assert.fail('booking should be cancelled');
      assert.equal(cancelled.duplicate, false);

      await admin.$executeRaw`
        UPDATE booking_policies
        SET cancellation_enabled=false, version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const cancellationReplay = await canceller.cancel(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: cancelKey,
          executionMode: 'live',
          bookingId: cancelReplayId,
          expectedVersion: 1,
          reason: 'Policy replay fixture',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(cancellationReplay.status, 'cancelled');
      if (cancellationReplay.status !== 'cancelled') assert.fail('replay should stay successful');
      assert.equal(cancellationReplay.duplicate, true);

      const rescheduleDisabled = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:reschedule-disabled`,
          executionMode: 'live',
          bookingId: rescheduleId,
          expectedVersion: 1,
          startsAt: '2026-09-23T10:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(rescheduleDisabled, {
        status: 'policy_denied',
        reason: 'disabled',
        minimumNoticeMinutes: 0,
      });

      await admin.$executeRaw`
        UPDATE booking_policies
        SET rescheduling_enabled=true, rescheduling_min_notice_minutes=525600,
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const rescheduleNotice = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:reschedule-notice`,
          executionMode: 'live',
          bookingId: rescheduleId,
          expectedVersion: 1,
          startsAt: '2026-09-23T10:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(rescheduleNotice, {
        status: 'policy_denied',
        reason: 'minimum_notice',
        minimumNoticeMinutes: 525600,
      });

      await admin.$executeRaw`
        UPDATE booking_policies
        SET rescheduling_enabled=true, rescheduling_min_notice_minutes=0,
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const rescheduleKey = `${turnId}:reschedule-replay`;
      const rescheduled = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: rescheduleKey,
          executionMode: 'live',
          bookingId: rescheduleId,
          expectedVersion: 1,
          startsAt: '2026-09-23T10:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(rescheduled.status, 'rescheduled');
      if (rescheduled.status !== 'rescheduled') assert.fail('booking should be rescheduled');
      assert.equal(rescheduled.duplicate, false);

      await admin.$executeRaw`
        UPDATE booking_policies
        SET rescheduling_enabled=false, version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid
      `;
      const rescheduleReplay = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: rescheduleKey,
          executionMode: 'live',
          bookingId: rescheduleId,
          expectedVersion: 1,
          startsAt: '2026-09-23T10:00:00Z',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(rescheduleReplay.status, 'rescheduled');
      if (rescheduleReplay.status !== 'rescheduled') assert.fail('replay should stay successful');
      assert.equal(rescheduleReplay.duplicate, true);

      const [visible] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM booking_policies WHERE tenant_id=${tenantId}::uuid
        `;
      });
      assert.equal(visible?.count, 1n);

      const [hidden] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM booking_policies WHERE tenant_id=${tenantId}::uuid
        `;
      });
      assert.equal(hidden?.count, 0n);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
