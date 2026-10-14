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
import { StripeCheckoutGateway } from '../src/billing/stripe-test-checkout-provider';
import { waitReady } from './wait-ready';

// Provider is intentionally a fake: no Stripe test credentials are present in CI.
// This tests the real HTTP/RBAC/Prisma/PostgreSQL RLS path, not Stripe's live sandbox.
// prettier-ignore
test('Stripe checkout intent is opt-in, tenant-bound, idempotent and never a subscription', { timeout: 40000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'integration needs MIGRATION_DATABASE_URL');
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  const gateway = app.get(StripeCheckoutGateway);
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
      method, headers: {
        Origin: config.CORS_ORIGIN, 'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const response = async <T>(r: Response, status: number): Promise<T> => {
    assert.equal(r.status, status, await r.clone().text());
    return r.json() as Promise<T>;
  };
  const register = async () => {
    const email = 'checkout-' + randomUUID() + '@example.test';
    const password = 'Checkout-pass-123!';
    assert.equal((await call('POST', '/auth/register',
      { email, password, name: 'Checkout test', termsAccepted: true })).status, 202);
    assert.equal((await call('POST', '/auth/verify',
      { token: verification.get(email) })).status, 204);
    const login = await response<{ access_token: string }>(
      await call('POST', '/auth/login', { email, password }), 200);
    const person = await admin.user.findUniqueOrThrow({ where: { email } });
    return { token: login.access_token, id: person.id };
  };
  const prices: string[] = [];
  const ids: string[] = [];
  gateway.validatePrice = async (plan) => { prices.push(plan.priceId); };
  gateway.createSession = async (args) => {
    ids.push(args.intentId);
    return {
      id: 'cs_test_' + args.intentId.replace(/-/g, ''),
      url: 'https://checkout.stripe.com/c/pay/' + args.intentId,
      expiresAt: new Date(Math.floor(args.expiresAt.getTime() / 1000) * 1000),
    };
  };
  try {
    await waitReady(base);
    const [owner, foreign] = await Promise.all([register(), register()]);
    const tenant = await response<{ id: string }>(await call('POST', '/tenants',
      { name: 'Checkout tenant', countryCode: 'PT', timezone: 'Europe/Lisbon' },
      owner.token), 201);
    const other = await response<{ id: string }>(await call('POST', '/tenants',
      { name: 'Other checkout tenant', countryCode: 'PT', timezone: 'Europe/Lisbon' },
      foreign.token), 201);
    const endpoint = '/tenants/' + tenant.id + '/billing/checkout';
    const planId = randomUUID();
    const disabledPlanId = randomUUID();
    const basePlan = {
      name: 'Test recurring', currency: 'EUR', billingInterval: 'month',
      basePrice: '19.990000', includedConversations: 10, includedMessages: null,
      includedStaff: 1, includedChannels: 1, includedLocations: 1,
      overagePricePerConversation: '0', features: {},
      stripeProductId: 'prod_test_'+randomUUID().replace(/-/g, ''),
    };
    await admin.billingPlan.create({
      data: { ...basePlan, id: planId, key: randomUUID(),
        stripePriceId: 'price_test_' + randomUUID().replace(/-/g, ''), active: true },
    });
    await admin.billingPlan.create({
      data: { ...basePlan, id: disabledPlanId, key: randomUUID(),
        stripePriceId: 'price_test_' + randomUUID().replace(/-/g, ''), active: false },
    });
    const requestId = randomUUID();
    const payload = { planId, requestId };
    assert.equal((await call('POST', endpoint, payload, owner.token)).status, 404,
      'disabled by default');
    config.STRIPE_TEST_CHECKOUT_ENABLED = 'true';
    config.STRIPE_TEST_SECRET_KEY = 'sk_test_' + 'a'.repeat(32);
    config.STRIPE_TEST_CHECKOUT_RETURN_ORIGIN = 'http://localhost:8080';
    assert.equal((await call('POST', endpoint, payload)).status, 401);
    assert.equal((await call('POST', endpoint, payload, foreign.token)).status, 404);
    assert.equal((await call('POST', endpoint, { planId: disabledPlanId, requestId },
      owner.token)).status, 400);
    assert.equal((await call('POST', endpoint, { ...payload, planId: 'bad' },
      owner.token)).status, 400);

    await admin.membership.create({
      data: { tenantId: tenant.id, userId: foreign.id, role: 'viewer' },
    });
    assert.equal((await call('POST', endpoint, payload, foreign.token)).status, 403);
    assert.equal((await call('POST', '/tenants/' + other.id + '/billing/checkout',
      payload, owner.token)).status, 404);
    const started = await response<{ checkoutUrl: string; expiresAt: string }>(
      await call('POST', endpoint, payload, owner.token), 201);
    assert(started.checkoutUrl.startsWith('https://checkout.stripe.com/'));
    assert.equal(ids.length, 1);
    assert.equal(prices.length, 1);
    assert.equal((await call('POST', endpoint, { planId, requestId: randomUUID() },
      owner.token)).status, 409, 'only one open intent');
    const again = await response<{ checkoutUrl: string }>(
      await call('POST', endpoint, payload, owner.token), 201);
    assert.equal(again.checkoutUrl, started.checkoutUrl);
    assert.equal(ids.length, 1, 'replay cannot create another Stripe session');
    assert.equal((await call('POST', endpoint, { planId: disabledPlanId, requestId },
      owner.token)).status, 400);

    const row = await admin.stripeCheckoutIntent.findUniqueOrThrow({
      where: { tenantId_requestId: { tenantId: tenant.id, requestId } },
    });
    assert.equal(row.status, 'ready');
    assert.equal(row.planId, planId);
    assert.equal(row.checkoutSessionId, 'cs_test_' + row.id.replace(/-/g, ''));
    assert.equal(row.checkoutUrl, started.checkoutUrl);
    assert.equal((await admin.tenantSubscription.count({ where: { tenantId: tenant.id } })), 0);
    const snapshot = await response<{ subscription: null; entitlements: {
      billingVerified: boolean; automationEnabled: boolean;
    } }>(await call('GET', '/tenants/' + tenant.id + '/billing/subscription',
      undefined, owner.token), 200);
    assert.equal(snapshot.subscription, null);
    assert.equal(snapshot.entitlements.billingVerified, false);
    assert.equal(snapshot.entitlements.automationEnabled, false);
    const [rls] = await deps.db.$queryRaw<Array<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname='stripe_checkout_intents'`;
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    const [privileges] = await deps.db.$queryRaw<Array<{
      canInsertSub: boolean; canUpdateSub: boolean; canDeleteIntent: boolean;
    }>>`SELECT
      has_table_privilege(current_user,'subscriptions','INSERT') AS "canInsertSub",
      has_table_privilege(current_user,'subscriptions','UPDATE') AS "canUpdateSub",
      has_table_privilege(current_user,'stripe_checkout_intents','DELETE') AS "canDeleteIntent"`;
    assert.deepEqual(privileges, {
      canInsertSub: false, canUpdateSub: false, canDeleteIntent: false,
    });
    const visible = await deps.db.stripeCheckoutIntent.count();
    assert.equal(visible, 0, 'runtime cannot see intents outside tenant scope');
    const blocking = await response<{ activation: { allowed: boolean; blockers: string[] } }>(
      await call('GET', '/tenants/' + tenant.id + '/onboarding', undefined, owner.token), 200);
    assert.equal(blocking.activation.allowed, false);
    assert(blocking.activation.blockers.includes('subscription'));

    // Timeout before a provider response: retry the SAME key and retain identity.
    const retryPayload = { planId, requestId: randomUUID() };
    await admin.stripeCheckoutIntent.update({
      where: { id: row.id }, data: { status: 'expired' },
    });
    let first = true;
    gateway.createSession = async (args) => {
      ids.push(args.intentId);
      if (first) { first = false; throw new Error('simulated timeout'); }
      return {
        id: 'cs_test_' + args.intentId.replace(/-/g, ''),
        url: 'https://checkout.stripe.com/c/pay/' + args.intentId,
        expiresAt: new Date(Math.floor(args.expiresAt.getTime() / 1000) * 1000),
      };
    };
    assert.equal((await call('POST', endpoint, retryPayload, owner.token)).status, 503);
    const pending = await admin.stripeCheckoutIntent.findUniqueOrThrow({
      where: { tenantId_requestId: { tenantId: tenant.id, requestId: retryPayload.requestId } },
    });
    assert.equal(pending.status, 'pending');
    const recovered = await response<{ checkoutUrl: string }>(
      await call('POST', endpoint, retryPayload, owner.token), 201);
    assert(recovered.checkoutUrl.includes(pending.id));
    assert.equal(ids[ids.length - 1], pending.id);
    assert.equal(ids[ids.length - 2], pending.id);
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
