import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { linkStoredStripeTestCheckout } from '../src/billing/stripe-checkout-linker';

const pid = () => randomUUID().replace(/-/g, '');
const eid = () => 'evt_' + pid();

// Real PostgreSQL/RLS and minimal linker role, with a deliberately mocked
// Stripe provider; no real Checkout, billing or entitlement activation.
// prettier-ignore
test('test Checkout linker authenticates ownership by stored intent, matches provider and replays safely', { timeout: 60000 }, async () => {
  assert(process.env.MIGRATION_DATABASE_URL);
  assert(process.env.BILLING_LINKER_DATABASE_URL);
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
  });
  const linker = new PrismaClient({
    datasources: { db: { url: process.env.BILLING_LINKER_DATABASE_URL } },
  });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const planId = randomUUID();
  const priceId = 'price_' + pid();
  const customerId = 'cus_' + pid();
  const subscriptionId = 'sub_' + pid();
  const start = Math.floor(Date.now() / 1000) - 60;
  const end = start + 30 * 86400;
  const sourcePlan = {
    id: planId, key: 'linked-' + pid(), name: 'Test plan',
    currency: 'EUR', basePrice: '19.990000', billingInterval: 'month',
    includedConversations: 10, includedMessages: null,
    includedStaff: 1, includedChannels: 1, includedLocations: 1,
    overagePricePerConversation: '0', features: {},
    stripeProductId: 'prod_' + pid(), stripePriceId: priceId, active: true,
  };
  const subscription = (overrides: Record<string,unknown> = {}): unknown => ({
    object: 'subscription', livemode: false, id: subscriptionId,
    customer: customerId, status: 'active', trial_end: null,
    cancel_at_period_end: false,
    items: {
      data: [{ price: { id: priceId }, current_period_start: start,
        current_period_end: end }],
      has_more: false,
    },
    ...overrides,
  });
  const setup = async (tenantId: string) => {
    const intentId = randomUUID();
    const sessionId = 'cs_test_' + pid();
    const expiresAt = new Date(Date.now() + 3600000);
    const intent = await admin.stripeCheckoutIntent.create({
      data: {
        id: intentId, tenantId, planId, requestId: randomUUID(),
        stripePriceId: priceId, status: 'ready',
        checkoutSessionId: sessionId,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/' + sessionId,
        expiresAt,
      },
    });
    const eventId = eid();
    await admin.stripeWebhookEvent.create({
      data: {
        eventId, eventType: 'checkout.session.completed',
        providerCreatedAt: new Date(), payloadSha256: 'a'.repeat(64),
        livemode: false,
        payload: {
          id: eventId, object: 'event', livemode: false,
          type: 'checkout.session.completed',
          data: { object: { id: sessionId, object: 'checkout.session',
            metadata: { tenant_id: tenantId === tenantA ? tenantB : tenantA } } },
        } as Prisma.InputJsonValue,
      },
    });
    return { intent, eventId };
  };
  try {
    await admin.tenant.create({
      data: { id: tenantA, name: 'Verified tenant', countryCode: 'PT',
        timezone: 'Europe/Lisbon' },
    });
    await admin.tenant.create({
      data: { id: tenantB, name: 'Foreign tenant', countryCode: 'PT',
        timezone: 'Europe/Lisbon' },
    });
    await admin.billingPlan.create({ data: sourcePlan });
    const { intent, eventId } = await setup(tenantA);
    const session = (overrides: Record<string,unknown> = {}): Record<string,unknown> => ({
      id: intent.checkoutSessionId, object: 'checkout.session',
      mode: 'subscription', livemode: false, status: 'complete',
      payment_status: 'paid', client_reference_id: intent.id,
      customer: customerId, subscription: subscriptionId,
      created: Math.floor(intent.createdAt.getTime() / 1000),
      expires_at: Math.floor(intent.expiresAt.getTime() / 1000),
      ...overrides,
    });
    let providerSession: unknown = session();
    let providerSubscription: unknown = subscription();
    let calls = 0;
    const provider = {
      retrieveSession: async (id: string) => {
        calls++;
        assert.equal(id, intent.checkoutSessionId);
        return providerSession;
      },
      retrieveSubscription: async (id: string) => {
        assert.equal(id, subscriptionId);
        return providerSubscription;
      },
    };
    await assert.rejects(linkStoredStripeTestCheckout(admin, eventId, provider),
      /Dedicated Stripe linker role required/);
    assert.equal(await admin.stripeCheckoutLinkAttempt.count(), 0);
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'linked', reason: 'provider_verified' });
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: tenantA },
    });
    assert.equal(row.planId, planId);
    assert.equal(row.providerSubscriptionId, subscriptionId);
    assert.equal(row.providerCustomerId, customerId);
    assert.equal(row.checkoutSessionId, intent.checkoutSessionId);
    assert.equal(row.status, 'active');
    assert.equal(await admin.tenantSubscription.count({ where: { tenantId: tenantB } }), 0);
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'replayed', reason: 'already_linked' });
    assert.equal(await admin.tenantSubscription.count({ where: { tenantId: tenantA } }), 1);
    assert.equal(await admin.stripeCheckoutLinkAttempt.count({ where: { eventId } }), 2);

    providerSession = session({ payment_status: 'unpaid' });
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'rejected', reason: 'payment_not_verified' });
    providerSession = session({ client_reference_id: randomUUID() });
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'rejected', reason: 'session_mismatch' });
    providerSession = session({ livemode: true });
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'rejected', reason: 'invalid_provider_snapshot' });
    providerSession = session();
    providerSubscription = subscription({ customer: 'cus_' + pid() });
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'rejected', reason: 'subscription_mismatch' });
    providerSubscription = subscription({ items: { data: [
      { price: { id: priceId }, current_period_start: start, current_period_end: end },
      { price: { id: priceId }, current_period_start: start, current_period_end: end },
    ], has_more: false } });
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, eventId, provider),
      { outcome: 'rejected', reason: 'invalid_provider_snapshot' });
    providerSubscription = subscription();

    // A second tenant cannot claim a subscription/customer belonging to A,
    // even if signed metadata claims it belongs to tenant B.
    const different = await setup(tenantB);
    const forB = {
      ...session(),
      id: different.intent.checkoutSessionId,
      client_reference_id: different.intent.id,
      created: Math.floor(different.intent.createdAt.getTime()/1000),
      expires_at: Math.floor(different.intent.expiresAt.getTime()/1000),
    };
    const conflicting = {
      retrieveSession: async () => forB,
      retrieveSubscription: async () => subscription(),
    };
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, different.eventId, conflicting),
      { outcome: 'rejected', reason: 'binding_conflict' });
    assert.equal(await admin.tenantSubscription.count({ where: { tenantId: tenantB } }), 0);
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, different.eventId, {
      retrieveSession: async () => { throw new Error('secret HTTP details'); },
      retrieveSubscription: async () => subscription(),
    }), { outcome: 'deferred', reason: 'provider_unavailable' });

    const unusedId = eid();
    await admin.stripeWebhookEvent.create({
      data: {
        eventId: unusedId, eventType: 'invoice.paid', livemode: false,
        providerCreatedAt: new Date(), payloadSha256: 'b'.repeat(64),
        payload: { data: { object: { id: intent.checkoutSessionId } } },
      },
    });
    const before = calls;
    assert.deepEqual(await linkStoredStripeTestCheckout(linker, unusedId, provider),
      { outcome: 'rejected', reason: 'event_not_eligible' });
    assert.equal(calls, before);

    // The linker has ONLY a bound INSERT route and immutable audit grants.
    const [access] = await admin.$queryRaw<Array<{
      canInsertSub: boolean; canUpdateSub: boolean; canChangePlan: boolean;
      canCreateTenant: boolean; canMutateEvent: boolean; canEditAudit: boolean;
      canRuntimeLink: boolean; canReconcilerLink: boolean;
    }>>`SELECT
      has_column_privilege('melissa_billing_linker','subscriptions',
        'provider_subscription_id','INSERT') AS "canInsertSub",
      has_column_privilege('melissa_billing_linker','subscriptions',
        'status','UPDATE') AS "canUpdateSub",
      has_column_privilege('melissa_billing_linker','subscriptions',
        'plan_id','UPDATE') AS "canChangePlan",
      has_table_privilege('melissa_billing_linker','tenants','INSERT') AS "canCreateTenant",
      has_table_privilege('melissa_billing_linker','stripe_webhook_events','UPDATE')
        AS "canMutateEvent",
      has_table_privilege('melissa_billing_linker','stripe_checkout_link_attempts','UPDATE')
        AS "canEditAudit",
      has_table_privilege('melissa_runtime','subscriptions','INSERT') AS "canRuntimeLink",
      has_table_privilege('melissa_billing_reconciler','subscriptions','INSERT')
        AS "canReconcilerLink"`;
    assert.deepEqual(access, {
      canInsertSub: true, canUpdateSub: false, canChangePlan: false,
      canCreateTenant: false, canMutateEvent: false, canEditAudit: false,
      canRuntimeLink: false, canReconcilerLink: false,
    });
    await assert.rejects(linker.tenantSubscription.update({
      where: { tenantId: tenantA }, data: { status: 'canceled' },
    }));
    await assert.rejects(linker.stripeWebhookEvent.delete({ where: { eventId } }));
    await assert.rejects(linker.tenant.create({
      data: { id: randomUUID(), name: 'Unsafe', countryCode: 'PT', timezone: 'Europe/Lisbon' },
    }));
    const [rls] = await admin.$queryRaw<Array<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname='stripe_checkout_link_attempts'`;
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    const attempts = await admin.stripeCheckoutLinkAttempt.findMany({ where: { eventId } });
    assert(attempts.every((attempt) => attempt.tenantId !== tenantB));
  } finally {
    await linker.$disconnect();
    await admin.$disconnect();
  }
});
