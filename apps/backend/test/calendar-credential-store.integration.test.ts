import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  CalendarCredentialKeyring,
  CalendarCredentialStore,
} from '../src/calendar/calendar-credential-store';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

const key = Buffer.alloc(32, 17);
const keyring: CalendarCredentialKeyring = {
  current: { id: 'calendar-v1', key },
  resolve: (keyId) => (keyId === 'calendar-v1' ? Buffer.from(key) : null),
};

test('calendar credentials are tenant-scoped, encrypted and authenticated', { timeout: 15000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'calendar credential integration requires MIGRATION_DATABASE_URL');
  const deps = new Dependencies(parseConfig(process.env));
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const tenantId = randomUUID();
  const connectionId = randomUUID();
  const accessToken = 'synthetic-access-token-with-sufficient-length';
  const refreshToken = 'synthetic-refresh-token-with-sufficient-length';
  const store = new CalendarCredentialStore(deps, keyring);

  try {
    await admin.tenant.create({
      data: {
        id: tenantId,
        name: 'Encrypted calendar credentials',
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.$executeRaw`
      INSERT INTO calendar_connections (
        tenant_id, id, provider, calendar_ref, credential_ref, status
      ) VALUES (
        ${tenantId}::uuid, ${connectionId}::uuid, 'google', 'primary',
        'secret://bootstrap/calendar', 'connected'
      )
    `;

    const reference = await store.put({
      tenantId,
      connectionId,
      credential: {
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        scopes: ['scope:b', 'scope:a', 'scope:a'],
      },
    });
    assert.equal(reference, `secret://calendar-db/${tenantId}/${connectionId}`);
    assert.equal(await store.resolve(reference), accessToken);

    const credential = await store.read(reference);
    assert.equal(credential.accessToken, accessToken);
    assert.equal(credential.refreshToken, refreshToken);
    assert.deepEqual(credential.scopes, ['scope:a', 'scope:b']);

    const [stored] = await admin.$queryRaw<
      Array<{ ciphertext: Buffer; credentialRef: string | null }>
    >`
      SELECT c.ciphertext, cc.credential_ref AS "credentialRef"
      FROM calendar_credentials c
      JOIN calendar_connections cc
        ON cc.tenant_id=c.tenant_id AND cc.id=c.connection_id
      WHERE c.tenant_id=${tenantId}::uuid AND c.connection_id=${connectionId}::uuid
    `;
    assert(stored);
    assert.equal(stored.credentialRef, reference);
    assert(!stored.ciphertext.includes(Buffer.from(accessToken)));
    assert(!stored.ciphertext.includes(Buffer.from(refreshToken)));

    const invisible = await deps.db.$queryRaw<Array<{ connectionId: string }>>`
      SELECT connection_id::text AS "connectionId" FROM calendar_credentials
    `;
    assert.deepEqual(invisible, []);

    await admin.$executeRaw`
      UPDATE calendar_credentials
      SET ciphertext=set_byte(ciphertext, 0, (get_byte(ciphertext, 0) + 1) % 256)
      WHERE tenant_id=${tenantId}::uuid AND connection_id=${connectionId}::uuid
    `;
    await assert.rejects(store.read(reference));

    await store.put({
      tenantId,
      connectionId,
      credential: {
        accessToken,
        refreshToken,
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        scopes: ['scope:a'],
      },
    });
    assert.equal((await store.read(reference)).accessToken, accessToken);
    await assert.rejects(store.resolve(reference));
  } finally {
    await deps.onModuleDestroy();
    await admin.$disconnect();
  }
});
