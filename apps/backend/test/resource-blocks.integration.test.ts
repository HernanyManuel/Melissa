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
  'resource blocks exclude buffered candidates, fence writes and remain tenant-scoped',
  { timeout: 20000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'resource block integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const serviceId = randomUUID();
    const engine = new BookingEngine(deps);
    const rescheduler = new PrismaBookingRescheduler(deps);

    try {
      await admin.tenant.createMany({
        data: [
          {
            id: tenantId,
            name: 'Resource block fixture',
            countryCode: 'PT',
            timezone: 'Europe/Lisbon',
          },
          {
            id: otherTenantId,
            name: 'Other resource block fixture',
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
          externalAccountId: `${Date.now()}-resource-block`,
          externalPhoneId: `${Date.now()}8`,
          displayName: 'Resource block channel',
          credentialsReference: 'secret://test/whatsapp',
          webhookSecretReference: 'secret://test/webhook',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Resource block customer',
          phoneE164: '+351910000090',
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
          name: 'Buffered block service',
          slug: `resource-block-${serviceId}`,
          price: '25.00',
          currency: 'EUR',
          durationMinutes: 30,
          bufferBeforeMinutes: 15,
          bufferAfterMinutes: 15,
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

      const resourceId = await engine.ensureDefaultResource(
        tenantId,
        new AbortController().signal,
      );

      let releaseResourceLock!: () => void;
      let resourceLocked!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        releaseResourceLock = resolve;
      });
      const lockedPromise = new Promise<void>((resolve) => {
        resourceLocked = resolve;
      });
      const holding = admin.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM booking_resources
          WHERE tenant_id=${tenantId}::uuid AND id=${resourceId}::uuid
          FOR UPDATE
        `;
        resourceLocked();
        await releasePromise;
      });
      await lockedPromise;
      try {
        await assert.rejects(
          admin.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
            await tx.$executeRaw`
              INSERT INTO resource_blocks (tenant_id, resource_id, starts_at, ends_at, reason)
              VALUES (
                ${tenantId}::uuid, ${resourceId}::uuid,
                ${new Date('2026-09-15T09:30:00Z')}, ${new Date('2026-09-15T10:00:00Z')},
                'Lock serialization probe'
              )
            `;
          }),
        );
      } finally {
        releaseResourceLock();
      }
      await holding;

      await admin.$executeRaw`
        INSERT INTO resource_blocks (tenant_id, resource_id, starts_at, ends_at, reason)
        VALUES (
          ${tenantId}::uuid, ${resourceId}::uuid,
          ${new Date('2026-09-15T09:30:00Z')}, ${new Date('2026-09-15T10:00:00Z')},
          'Maintenance fixture'
        )
      `;

      const availability = await engine.availableSlots(
        { tenantId, serviceId, date: '2026-09-15' },
        new AbortController().signal,
      );
      assert.equal(availability.resourceId, resourceId);
      assert(!availability.slots.some((slot) => slot.startsAt === '2026-09-15T09:00:00.000Z'));
      assert(!availability.slots.some((slot) => slot.startsAt === '2026-09-15T09:15:00.000Z'));
      assert(!availability.slots.some((slot) => slot.startsAt === '2026-09-15T09:30:00.000Z'));
      assert(!availability.slots.some((slot) => slot.startsAt === '2026-09-15T09:45:00.000Z'));

      const blockedCreate = await engine.createBooking(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:blocked-create`,
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
          idempotencyKey: `${turnId}:created`,
          executionMode: 'live',
          serviceId,
          startsAt: '2026-09-15T09:00:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.equal(created.status, 'created');
      if (created.status !== 'created') assert.fail('unblocked booking should be created');

      const blockedReschedule = await rescheduler.reschedule(
        {
          tenantId,
          conversationId,
          customerId,
          turnId,
          expectedModeEpoch: 51n,
          idempotencyKey: `${turnId}:blocked-reschedule`,
          executionMode: 'live',
          bookingId: created.bookingId,
          expectedVersion: 1,
          startsAt: '2026-09-15T10:15:00+01:00',
          confirmed: true,
        },
        new AbortController().signal,
      );
      assert.deepEqual(blockedReschedule, { status: 'unavailable' });

      const [unchanged] = await admin.$queryRaw<Array<{ starts_at: Date; version: number }>>`
        SELECT starts_at, version
        FROM bookings
        WHERE tenant_id=${tenantId}::uuid AND id=${created.bookingId}::uuid
      `;
      assert.equal(unchanged?.starts_at.toISOString(), '2026-09-15T08:00:00.000Z');
      assert.equal(unchanged?.version, 1);

      const [visible] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count
          FROM resource_blocks
          WHERE tenant_id=${tenantId}::uuid
        `;
      });
      assert.equal(visible?.count, 1n);

      const [hidden] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count
          FROM resource_blocks
          WHERE tenant_id=${tenantId}::uuid
        `;
      });
      assert.equal(hidden?.count, 0n);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
