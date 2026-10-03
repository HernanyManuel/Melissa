import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient, TenantRole } from '@prisma/client';
import { CalendarOAuthStateService } from '../src/calendar/calendar-oauth-state.service';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { Actor } from '../src/identity/auth.service';
import { IdentityMail } from '../src/identity/mail';
import { tokenHash } from '../src/identity/password';
import { TenantService } from '../src/tenancy/tenant.service';

interface Fixture {
  actor: Actor;
  tenantId: string;
  membershipId: string;
}

async function createFixture(admin: PrismaClient, role: TenantRole = 'owner'): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const sessionId = randomUUID();
  await admin.user.create({
    data: {
      id: userId,
      email: `${userId}@oauth.test`,
      name: 'Calendar OAuth fixture',
      passwordHash: 'fixture-password-hash',
      termsVersion: 'test',
      termsAcceptedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
  await admin.tenant.create({
    data: {
      id: tenantId,
      name: 'Calendar OAuth tenant',
      countryCode: 'PT',
      timezone: 'Europe/Lisbon',
    },
  });
  const membership = await admin.membership.create({
    data: { tenantId, userId, role, active: true },
  });
  await admin.session.create({
    data: {
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  return { actor: { userId, sessionId }, tenantId, membershipId: membership.id };
}

test(
  'calendar OAuth state is tenant/session bound, one-time and permission gated',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'calendar OAuth state integration requires MIGRATION_DATABASE_URL');
    const config = parseConfig(process.env);
    const deps = new Dependencies(config);
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenants = new TenantService(deps, new IdentityMail(config));
    const callback = 'https://app.example.test/oauth/google/callback';
    const oauth = new CalendarOAuthStateService(deps, tenants, [
      callback,
      'http://127.0.0.1:8080/oauth/google/callback',
    ]);

    try {
      const owner = await createFixture(admin, 'owner');
      const started = await oauth.begin(owner.actor, owner.tenantId, callback);
      assert.match(started.state, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(started.codeChallengeMethod, 'S256');
      assert.match(started.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(started.redirectUri, callback);

      const consumed = await oauth.consume(started.state);
      assert.equal(consumed.tenantId, owner.tenantId);
      assert.equal(consumed.userId, owner.actor.userId);
      assert.equal(consumed.sessionId, owner.actor.sessionId);
      assert.equal(consumed.redirectUri, callback);
      assert.match(consumed.pkceVerifier, /^[A-Za-z0-9_-]{64}$/);
      await assert.rejects(oauth.consume(started.state));

      const replacementA = await oauth.begin(owner.actor, owner.tenantId, callback);
      const replacementB = await oauth.begin(owner.actor, owner.tenantId, callback);
      await assert.rejects(oauth.consume(replacementA.state));
      assert.equal((await oauth.consume(replacementB.state)).tenantId, owner.tenantId);

      await assert.rejects(
        oauth.begin(owner.actor, owner.tenantId, 'https://evil.example.test/oauth/google/callback'),
      );
      await assert.rejects(
        oauth.begin(
          owner.actor,
          owner.tenantId,
          'https://user:pass@app.example.test/oauth/google/callback',
        ),
      );
      await assert.rejects(
        oauth.begin(
          owner.actor,
          owner.tenantId,
          'https://app.example.test/oauth/google/callback#token',
        ),
      );

      const manager = await createFixture(admin, 'manager');
      await assert.rejects(oauth.begin(manager.actor, manager.tenantId, callback));

      const revoked = await createFixture(admin, 'admin');
      const revokedState = await oauth.begin(revoked.actor, revoked.tenantId, callback);
      await admin.session.update({
        where: { id: revoked.actor.sessionId },
        data: { revokedAt: new Date() },
      });
      await assert.rejects(oauth.consume(revokedState.state));

      const downgraded = await createFixture(admin, 'admin');
      const downgradedState = await oauth.begin(downgraded.actor, downgraded.tenantId, callback);
      await admin.membership.update({
        where: { id: downgraded.membershipId },
        data: { role: 'manager' },
      });
      await assert.rejects(oauth.consume(downgradedState.state));

      const expired = await createFixture(admin, 'owner');
      const expiredState = await oauth.begin(expired.actor, expired.tenantId, callback);
      await admin.$executeRaw`
        UPDATE calendar_oauth_states
        SET expires_at=CURRENT_TIMESTAMP - interval '1 second'
        WHERE state_hash=${tokenHash(expiredState.state)}
      `;
      await assert.rejects(oauth.consume(expiredState.state));

      const isolatedA = await createFixture(admin, 'owner');
      const isolatedB = await createFixture(admin, 'owner');
      const stateA = await oauth.begin(isolatedA.actor, isolatedA.tenantId, callback);
      const stateB = await oauth.begin(isolatedB.actor, isolatedB.tenantId, callback);
      const visible = await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.oauth_state_hash', ${tokenHash(
          stateA.state,
        )}, true)`;
        return tx.$queryRaw<Array<{ stateHash: string }>>`
          SELECT state_hash AS "stateHash"
          FROM calendar_oauth_states
          ORDER BY state_hash
        `;
      });
      assert.deepEqual(visible, [{ stateHash: tokenHash(stateA.state) }]);
      assert.notEqual(tokenHash(stateA.state), tokenHash(stateB.state));

      const auditActions = await admin.auditEvent.findMany({
        where: { tenantId: owner.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { action: true },
      });
      assert(auditActions.some((entry) => entry.action === 'calendar.oauth_started'));
      assert(auditActions.some((entry) => entry.action === 'calendar.oauth_state_consumed'));
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
