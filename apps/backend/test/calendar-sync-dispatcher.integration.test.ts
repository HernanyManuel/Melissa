import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { discoverConnectedCalendars } from '../src/calendar/calendar-sync-dispatcher';

test('calendar sync discovery exposes only connected tenant and connection ids', async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'calendar sync dispatcher integration requires MIGRATION_DATABASE_URL');
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const connectedA = randomUUID();
  const connectedB = randomUUID();
  const reauth = randomUUID();

  try {
    await admin.tenant.createMany({
      data: [
        { id: tenantA, name: 'Calendar dispatcher A', countryCode: 'PT', timezone: 'Europe/Lisbon' },
        { id: tenantB, name: 'Calendar dispatcher B', countryCode: 'PT', timezone: 'Europe/Lisbon' },
      ],
    });
    await admin.$executeRaw`
      INSERT INTO calendar_connections (
        tenant_id, id, provider, calendar_ref, credential_ref, status
      ) VALUES
        (${tenantA}::uuid, ${connectedA}::uuid, 'google', 'primary', 'secret://test/a', 'connected'),
        (${tenantB}::uuid, ${connectedB}::uuid, 'google', 'primary', 'secret://test/b', 'connected'),
        (${tenantA}::uuid, ${reauth}::uuid, 'google', 'secondary', 'secret://test/c', 'reauth_required')
    `;

    const discovered = await discoverConnectedCalendars(admin);
    const ours = discovered.filter((item) => item.tenantId === tenantA || item.tenantId === tenantB);
    assert.deepEqual(
      ours,
      [
        { tenantId: tenantA, connectionId: connectedA },
        { tenantId: tenantB, connectionId: connectedB },
      ].sort(
        (a, b) =>
          a.tenantId.localeCompare(b.tenantId) || a.connectionId.localeCompare(b.connectionId),
      ),
    );
    assert(!ours.some((item) => item.connectionId === reauth));
    for (const item of ours) assert.deepEqual(Object.keys(item).sort(), ['connectionId', 'tenantId']);
  } finally {
    await admin.$executeRaw`DELETE FROM tenants WHERE id IN (${tenantA}::uuid, ${tenantB}::uuid)`;
    await admin.$disconnect();
  }
});
