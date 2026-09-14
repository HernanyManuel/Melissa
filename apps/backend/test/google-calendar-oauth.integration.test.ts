import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  CalendarCredentialKeyring,
  CalendarCredentialStore,
} from '../src/calendar/calendar-credential-store';
import { CalendarOAuthStateService } from '../src/calendar/calendar-oauth-state.service';
import { GoogleCalendarOAuthService } from '../src/calendar/google-calendar-oauth.service';
import { GoogleOAuthTokenClient } from '../src/calendar/google-oauth-token-client';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { IdentityMail } from '../src/identity/mail';
import { SecretResolver } from '../src/secrets/secret-resolver';
import { TenantService } from '../src/tenancy/tenant.service';

const callback = 'https://app.example.test/oauth/google/callback';
const secretReference = 'secret://config/google-client-secret';
const encryptionKey = Buffer.alloc(32, 29);
const keyring: CalendarCredentialKeyring = {
  current: { id: 'calendar-v1', key: encryptionKey },
  resolve: (keyId) => (keyId === 'calendar-v1' ? Buffer.from(encryptionKey) : null),
};

class MemorySecrets implements SecretResolver {
  async resolve(reference: string): Promise<string> {
    assert.equal(reference, secretReference);
    return 'synthetic-google-client-secret';
  }
}

async function createFixture(admin: PrismaClient) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const sessionId = randomUUID();
  await admin.user.create({
    data: {
      id: userId,
      email: `${userId}@google-oauth.test`,
      name: 'Google OAuth completion fixture',
      passwordHash: 'fixture-password-hash',
      termsVersion: 'test',
      termsAcceptedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
  await admin.tenant.create({
    data: {
      id: tenantId,
      name: 'Google OAuth completion tenant',
      countryCode: 'PT',
      timezone: 'Europe/Lisbon',
    },
  });
  await admin.membership.create({
    data: { tenantId, userId, role: 'owner', active: true },
  });
  await admin.session.create({
    data: {
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  return { tenantId, actor: { userId, sessionId } };
}

test(
  'Google Calendar OAuth completion is replay-safe, encrypted and transactionally reauthenticates',
  { timeout: 20000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'Google Calendar OAuth integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenants = new TenantService(deps, new IdentityMail(config));
    const states = new CalendarOAuthStateService(deps, tenants, [callback]);
    const credentials = new CalendarCredentialStore(deps, keyring);
    let exchanges = 0;
    const tokens = new GoogleOAuthTokenClient(
      new MemorySecrets(),
      'google-client-id',
      secretReference,
      1000,
      async (_url, init) => {
        exchanges += 1;
        const request = new URLSearchParams(String(init.body));
        const suffix = request.get('code') === 'second-code' ? 'second' : 'first';
        return new Response(
          JSON.stringify({
            access_token: `synthetic-access-token-${suffix}-sufficient-length`,
            refresh_token: `synthetic-refresh-token-${suffix}-sufficient-length`,
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/calendar.readonly',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    const service = new GoogleCalendarOAuthService(
      deps,
      tenants,
      states,
      tokens,
      credentials,
    );

    try {
      const fixture = await createFixture(admin);
      const firstState = await states.begin(fixture.actor, fixture.tenantId, callback);
      const first = await service.complete(firstState.state, 'first-code');
      assert.equal(first.calendarRef, 'primary');
      assert.equal(first.status, 'connected');
      await assert.rejects(service.complete(firstState.state, 'replayed-code'));
      assert.equal(exchanges, 1);

      const reference = `secret://calendar-db/${fixture.tenantId}/${first.connectionId}`;
      const firstCredential = await credentials.read(reference);
      assert.equal(
        firstCredential.refreshToken,
        'synthetic-refresh-token-first-sufficient-length',
      );

      const [stored] = await admin.$queryRaw<
        Array<{ ciphertext: Buffer; syncVersion: bigint; status: string }>
      >`
        SELECT
          c.ciphertext,
          cc.sync_version AS "syncVersion",
          cc.status
        FROM calendar_credentials c
        JOIN calendar_connections cc
          ON cc.tenant_id=c.tenant_id AND cc.id=c.connection_id
        WHERE c.tenant_id=${fixture.tenantId}::uuid
          AND c.connection_id=${first.connectionId}::uuid
      `;
      assert(stored);
      assert.equal(stored.syncVersion, 0n);
      assert.equal(stored.status, 'connected');
      assert(!stored.ciphertext.includes(Buffer.from('synthetic-refresh-token-first')));

      await admin.$executeRaw`
        UPDATE calendar_connections
        SET
          sync_token='old-sync-token',
          sync_version=4,
          last_success_at=CURRENT_TIMESTAMP,
          coverage_starts_at=CURRENT_TIMESTAMP,
          coverage_ends_at=CURRENT_TIMESTAMP + interval '1 hour'
        WHERE tenant_id=${fixture.tenantId}::uuid
          AND id=${first.connectionId}::uuid
      `;
      await admin.$executeRaw`
        INSERT INTO calendar_busy_intervals (
          tenant_id, connection_id, id, starts_at, ends_at, sync_version, observed_at
        ) VALUES (
          ${fixture.tenantId}::uuid,
          ${first.connectionId}::uuid,
          ${randomUUID()}::uuid,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + interval '30 minutes',
          4,
          CURRENT_TIMESTAMP
        )
      `;

      const secondState = await states.begin(fixture.actor, fixture.tenantId, callback);
      const second = await service.complete(secondState.state, 'second-code');
      assert.equal(second.connectionId, first.connectionId);
      const secondCredential = await credentials.read(reference);
      assert.equal(
        secondCredential.refreshToken,
        'synthetic-refresh-token-second-sufficient-length',
      );

      const [reauthenticated] = await admin.$queryRaw<
        Array<{
          syncVersion: bigint;
          syncToken: string | null;
          lastSuccessAt: Date | null;
          coverageStartsAt: Date | null;
          coverageEndsAt: Date | null;
        }>
      >`
        SELECT
          sync_version AS "syncVersion",
          sync_token AS "syncToken",
          last_success_at AS "lastSuccessAt",
          coverage_starts_at AS "coverageStartsAt",
          coverage_ends_at AS "coverageEndsAt"
        FROM calendar_connections
        WHERE tenant_id=${fixture.tenantId}::uuid
          AND id=${first.connectionId}::uuid
      `;
      assert(reauthenticated);
      assert.equal(reauthenticated.syncVersion, 5n);
      assert.equal(reauthenticated.syncToken, null);
      assert.equal(reauthenticated.lastSuccessAt, null);
      assert.equal(reauthenticated.coverageStartsAt, null);
      assert.equal(reauthenticated.coverageEndsAt, null);
      const [busyCount] = await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM calendar_busy_intervals
        WHERE tenant_id=${fixture.tenantId}::uuid
          AND connection_id=${first.connectionId}::uuid
      `;
      assert.equal(busyCount?.count, 0n);

      const actions = await admin.auditEvent.findMany({
        where: { tenantId: fixture.tenantId, action: 'calendar.google_connected' },
      });
      assert.equal(actions.length, 2);
      assert(actions.every((entry) => entry.targetId === first.connectionId));

      const rollbackFixture = await createFixture(admin);
      const rollbackState = await states.begin(
        rollbackFixture.actor,
        rollbackFixture.tenantId,
        callback,
      );
      const failingCredentials = {
        putInTransaction: async () => {
          throw new Error('synthetic persistence failure');
        },
      } as unknown as CalendarCredentialStore;
      const failingService = new GoogleCalendarOAuthService(
        deps,
        tenants,
        states,
        tokens,
        failingCredentials,
      );
      await assert.rejects(failingService.complete(rollbackState.state, 'rollback-code'));
      const [connectionCount] = await admin.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM calendar_connections
        WHERE tenant_id=${rollbackFixture.tenantId}::uuid
          AND provider='google'
      `;
      assert.equal(connectionCount?.count, 0n);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
