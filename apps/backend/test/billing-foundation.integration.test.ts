import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { IdentityMail } from '../src/identity/mail';
import { configureHttp } from '../src/http';
import { waitReady } from './wait-ready';

// No Stripe transport is configured. These are provider snapshots seeded by
// the privileged test role, never created by any untrusted HTTP caller.
// prettier-ignore
test('Phase 9 billing foundation isolates tenant subscriptions and fails closed', { timeout: 30000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'billing integration requires MIGRATION_DATABASE_URL');
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  const deps = app.get(Dependencies);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const verification = new Map<string, string>();
  app.get(IdentityMail).send = async (email, purpose, token) => {
    if (purpose === 'verify') verification.set(email, token);
  };
  configureHttp(app, config, false);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const call = (method: string, path: string, body?: object, token?: string) =>
    fetch(base + '/api/v1' + path, {
      method,
      headers: {
        Origin: config.CORS_ORIGIN,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const data = async <T>(response: Response, status: number): Promise<T> => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<T>;
  };
  const register = async () => {
    const email = `billing-${randomUUID()}@example.test`;
    const password = 'Billing-integration-123!';
    assert.equal((await call('POST', '/auth/register', {
      email, password, name: 'Billing test', termsAccepted: true,
    })).status, 202);
    assert.equal((await call('POST', '/auth/verify', { token: verification.get(email) })).status, 204);
    const result = await data<{ access_token: string }>(
      await call('POST', '/auth/login', { email, password }), 200,
    );
    const actor = await admin.user.findUniqueOrThrow({ where: { email } });
    return { token: result.access_token, id: actor.id };
  };
  try {
    await waitReady(base);
    const [owner, foreign] = await Promise.all([register(), register()]);
    const tenantA = await data<{ id: string }>(await call('POST', '/tenants',
      { name: 'Billing A', countryCode: 'PT', timezone: 'Europe/Lisbon' }, owner.token), 201);
    const tenantB = await data<{ id: string }>(await call('POST', '/tenants',
      { name: 'Billing B', countryCode: 'PT', timezone: 'Europe/Lisbon' }, foreign.token), 201);
    const plansA = `/tenants/${tenantA.id}/billing/plans`;
    const subscriptionA = `/tenants/${tenantA.id}/billing/subscription`;
    assert.equal((await call('GET', plansA)).status, 401);
    assert.equal((await call('GET', plansA, undefined, foreign.token)).status, 404);
    assert.equal((await call('GET', subscriptionA, undefined, foreign.token)).status, 404);
    const empty = await data<{
      subscription: null; entitlements: { automationEnabled: boolean; billingVerified: boolean };
    }>(await call('GET', subscriptionA, undefined, owner.token), 200);
    assert.equal(empty.subscription, null);
    assert.deepEqual(empty.entitlements, {
      automationEnabled: false, billingVerified: false, reason: 'billing_not_enabled',
    });

    const planId = randomUUID();
    const unpublishedId = randomUUID();
    const key = 'test-' + randomUUID();
    const planData = {
      key, name: 'Controlled sample', currency: 'EUR', basePrice: '19.990000',
      billingInterval: 'month', includedConversations: 300,
      includedMessages: null, includedStaff: 1, includedChannels: 1,
      includedLocations: 1, overagePricePerConversation: '0.080000',
      features: { handoff: true, analytics: false },
      stripeProductId: 'prod_private_test', stripePriceId: 'price_private_test-' + randomUUID(),
      active: true,
    };
    await admin.billingPlan.create({ data: { id: planId, ...planData } });
    await admin.billingPlan.create({ data: { id: unpublishedId,
      ...planData, key: 'disabled-' + randomUUID(), active: false,
      stripePriceId: 'price_disabled-' + randomUUID(),
    } });
    const listed = await data<{ items: Array<Record<string, unknown>> }>(
      await call('GET', plansA, undefined, owner.token), 200,
    );
    assert(listed.items.some((row) => row.id === planId));
    assert(!listed.items.some((row) => row.id === unpublishedId));
    const current = listed.items.find((row) => row.id === planId)!;
    assert.equal(current.basePrice, '19.99');
    assert.equal(current.overagePricePerConversation, '0.08');
    assert.equal(current.includedConversations, 300);
    assert.deepEqual(current.features, { handoff: true, analytics: false });
    assert(!('stripePriceId' in current));
    assert(!('stripeProductId' in current));

    await admin.membership.create({
      data: { tenantId: tenantA.id, userId: foreign.id, role: 'viewer' },
    });
    assert.equal((await call('GET', plansA, undefined, foreign.token)).status, 403);
    assert.equal((await call('GET', subscriptionA, undefined, foreign.token)).status, 403);
    assert.equal((await call('POST', plansA, { active: true }, owner.token)).status, 404);
    assert.equal((await call('POST', subscriptionA, { status: 'active' }, owner.token)).status, 404);

    const subId = randomUUID();
    await admin.tenantSubscription.create({
      data: {
        id: subId, tenantId: tenantA.id, planId, provider: 'stripe',
        providerCustomerId: 'cus_private_test',
        providerSubscriptionId: 'sub_private_test-' + randomUUID(),
        status: 'active',
        currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
        cancelAtPeriodEnd: false,
      },
    });
    const detail = await data<{
      subscription: { id: string; provider: string; status: string; plan: { id: string } };
      entitlements: { automationEnabled: boolean; billingVerified: boolean };
    }>(await call('GET', subscriptionA, undefined, owner.token), 200);
    assert.equal(detail.subscription.id, subId);
    assert.equal(detail.subscription.provider, 'stripe');
    assert.equal(detail.subscription.status, 'active');
    assert.equal(detail.subscription.plan.id, planId);
    assert.equal(detail.entitlements.automationEnabled, false);
    assert.equal(detail.entitlements.billingVerified, false);
    assert(!JSON.stringify(detail).includes('cus_private_test'));
    assert(!JSON.stringify(detail).includes('sub_private_test'));
    assert(!JSON.stringify(detail).includes('price_private_test'));
    assert.equal((await call('GET', subscriptionA, undefined, foreign.token)).status, 403);
    const other = await data<{ subscription: null }>(
      await call('GET', `/tenants/${tenantB.id}/billing/subscription`,
        undefined, foreign.token), 200,
    );
    assert.equal(other.subscription, null);

    // A guessed tenant scope outside TenantService must not expose rows.
    const [rls] = await deps.db.$queryRaw<Array<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>>`SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname='subscriptions'`;
    assert(rls);
    assert.equal(rls.relrowsecurity, true);
    assert.equal(rls.relforcerowsecurity, true);
    const [grants] = await deps.db.$queryRaw<Array<{
      canInsert: boolean; canUpdate: boolean; canDelete: boolean;
    }>>`SELECT
       has_table_privilege(current_user, 'subscriptions', 'INSERT') AS "canInsert",
       has_table_privilege(current_user, 'subscriptions', 'UPDATE') AS "canUpdate",
       has_table_privilege(current_user, 'subscriptions', 'DELETE') AS "canDelete"`;
    assert.deepEqual(grants, { canInsert: false, canUpdate: false, canDelete: false });
    const [visible] = await deps.db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM subscriptions`;
    assert(visible);
    assert.equal(visible.count, 0n);
    const readiness = await data<{ status: string }>(
      await fetch(base + '/health/ready'), 200,
    );
    assert.equal(readiness.status, 'ok');
    const onboarding = await data<{ activation: { allowed: boolean; blockers: string[] } }>(
      await call('GET', `/tenants/${tenantA.id}/onboarding`, undefined, owner.token), 200,
    );
    assert.equal(onboarding.activation.allowed, false);
    assert(onboarding.activation.blockers.includes('subscription'));
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
