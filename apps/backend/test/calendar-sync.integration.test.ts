import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { CalendarProviderConflict } from '../src/calendar/calendar-provider';
import { CalendarSyncStore } from '../src/calendar/calendar-sync-store';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

test(
  'calendar sync cache is tenant-scoped, monotonic and freshness-gated',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'calendar integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const store = new CalendarSyncStore(deps);
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const connectionId = randomUUID();
    const staffConnectionId = randomUUID();
    const staffId = randomUUID();
    const otherStaffId = randomUUID();
    const observedAt = new Date('2030-01-01T10:00:00Z');

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Calendar fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.tenant.create({
        data: {
          id: otherTenantId,
          name: 'Other calendar fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.staff.create({
        data: {
          id: staffId,
          tenantId,
          name: 'Calendar staff',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.staff.create({
        data: {
          id: otherStaffId,
          tenantId: otherTenantId,
          name: 'Other tenant staff',
          timezone: 'Europe/Lisbon',
        },
      });

      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`
          INSERT INTO calendar_connections (
            tenant_id, id, provider, calendar_ref, status, freshness_limit_seconds
          ) VALUES (
            ${tenantId}::uuid, ${connectionId}::uuid, 'mock', 'mock:primary', 'connected', 60
          )
        `;
        await tx.$executeRaw`
          INSERT INTO calendar_connections (
            tenant_id, id, staff_id, provider, calendar_ref, status, freshness_limit_seconds
          ) VALUES (
            ${tenantId}::uuid,
            ${staffConnectionId}::uuid,
            ${staffId}::uuid,
            'mock',
            'mock:staff',
            'connected',
            60
          )
        `;
      });

      const [defaultMapping, staffMapping] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ id: string; staffId: string | null }>>`
          SELECT id, staff_id AS "staffId"
          FROM calendar_connections
          WHERE tenant_id=${tenantId}::uuid
          ORDER BY calendar_ref ASC
        `;
      });
      assert.equal(defaultMapping?.id, connectionId);
      assert.equal(defaultMapping?.staffId, null);
      assert.equal(staffMapping?.id, staffConnectionId);
      assert.equal(staffMapping?.staffId, staffId);

      await assert.rejects(
        deps.db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`
            INSERT INTO calendar_connections (
              tenant_id, id, staff_id, provider, calendar_ref, status
            ) VALUES (
              ${tenantId}::uuid,
              ${randomUUID()}::uuid,
              ${otherStaffId}::uuid,
              'mock',
              'mock:foreign-staff',
              'connected'
            )
          `;
        }),
      );

      const neverSynced = await store.busySnapshot({
        tenantId,
        connectionId,
        startsAt: new Date('2030-01-01T09:00:00Z'),
        endsAt: new Date('2030-01-01T13:00:00Z'),
        now: observedAt,
      });
      assert.equal(neverSynced.reason, 'never_synced');
      assert.equal(neverSynced.fresh, false);
      assert.deepEqual(neverSynced.intervals, []);

      const version = await store.replaceBusySnapshot({
        tenantId,
        connectionId,
        expectedSyncVersion: 0n,
        observedAt,
        syncToken: 'opaque-sync-token-1',
        intervals: [
          {
            startsAt: new Date('2030-01-01T09:30:00Z'),
            endsAt: new Date('2030-01-01T10:30:00Z'),
          },
          {
            startsAt: new Date('2030-01-01T12:00:00Z'),
            endsAt: new Date('2030-01-01T13:00:00Z'),
          },
        ],
      });
      assert.equal(version, 1n);

      const fresh = await store.busySnapshot({
        tenantId,
        connectionId,
        startsAt: new Date('2030-01-01T10:00:00Z'),
        endsAt: new Date('2030-01-01T11:00:00Z'),
        now: new Date('2030-01-01T10:00:30Z'),
      });
      assert.equal(fresh.reason, 'fresh');
      assert.equal(fresh.fresh, true);
      assert.equal(fresh.syncVersion, 1n);
      assert.equal(fresh.observedAt, observedAt.toISOString());
      assert.deepEqual(fresh.intervals, [
        { startsAt: '2030-01-01T09:30:00.000Z', endsAt: '2030-01-01T10:30:00.000Z' },
      ]);

      await assert.rejects(
        store.replaceBusySnapshot({
          tenantId,
          connectionId,
          expectedSyncVersion: 0n,
          observedAt: new Date('2030-01-01T10:00:45Z'),
          syncToken: 'opaque-sync-token-stale',
          intervals: [],
        }),
        (error) => error instanceof CalendarProviderConflict,
      );

      const stale = await store.busySnapshot({
        tenantId,
        connectionId,
        startsAt: new Date('2030-01-01T09:00:00Z'),
        endsAt: new Date('2030-01-01T14:00:00Z'),
        now: new Date('2030-01-01T10:01:01Z'),
      });
      assert.equal(stale.reason, 'stale');
      assert.equal(stale.syncVersion, 1n);
      assert.deepEqual(stale.intervals, []);

      await assert.rejects(
        store.busySnapshot({
          tenantId: otherTenantId,
          connectionId,
          startsAt: new Date('2030-01-01T09:00:00Z'),
          endsAt: new Date('2030-01-01T14:00:00Z'),
          now: observedAt,
        }),
        (error) => error instanceof CalendarProviderConflict,
      );

      const [hidden] = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${otherTenantId}, true)`;
        return tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count
          FROM calendar_busy_intervals
          WHERE connection_id=${connectionId}::uuid
        `;
      });
      assert.equal(hidden?.count, 0n);

      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`
          UPDATE calendar_connections
          SET status='disconnected', updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=${tenantId}::uuid AND id=${connectionId}::uuid
        `;
      });
      const disconnected = await store.busySnapshot({
        tenantId,
        connectionId,
        startsAt: new Date('2030-01-01T09:00:00Z'),
        endsAt: new Date('2030-01-01T14:00:00Z'),
        now: observedAt,
      });
      assert.equal(disconnected.reason, 'disconnected');
      assert.deepEqual(disconnected.intervals, []);
    } finally {
      try {
        await admin.$executeRaw`
          DELETE FROM calendar_connections
          WHERE tenant_id=${tenantId}::uuid OR tenant_id=${otherTenantId}::uuid
        `;
        await admin.staff.deleteMany({
          where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
        await admin.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
      } finally {
        await deps.onModuleDestroy();
        await admin.$disconnect();
      }
    }
  },
);
