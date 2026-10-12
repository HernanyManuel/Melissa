import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  reconcileStoredStripeTestEvent,
  stripeTestSubscriptionSnapshot,
} from '../src/billing/stripe-reconciler';
import { StripeTestSubscriptionReader } from '../src/billing/stripe-test-subscription-reader';

const pid = () => randomUUID().replace(/-/g, '');
const eventId = () => 'evt_' + pid();

// prettier-ignore
test('Stripe test reconciliation: trusted mapping, latest provider snapshot, isolation and audit', { timeout: 60000 }, async () => {
  const url = process.env.MIGRATION_DATABASE_URL;
  assert(url, 'requires privileged fixture connection');
  const db = new PrismaClient({ datasources: { db: { url } } });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const planId = randomUUID();
  const subscriptionId = randomUUID();
  const providerId = 'sub_' + pid();
  const customerId = 'cus_' + pid();
  const priceId = 'price_' + pid();
  const start = 1790899200; // 2026-10-02T00:00:00Z
  const end = 1793577600; // 2026-11-02T00:00:00Z
  const next = 1796256000; // 2026-12-03T00:00:00Z
  const planData = {
    key: 'reconcile-' + pid(),
    name: 'Test plan',
    currency: 'EUR',
    basePrice: '19.990000',
    billingInterval: 'month',
    includedConversations: 300,
    includedStaff: 1,
    includedChannels: 1,
    includedLocations: 1,
    overagePricePerConversation: '0.010000',
    features: {},
    active: true,
    stripeProductId: 'prod_' + pid(),
    stripePriceId: priceId,
  };
  const payload = (
    eventType = 'customer.subscription.updated',
    data: Record<string, unknown> = {
      id: providerId, customer: customerId, status: 'canceled',
      metadata: { tenant_id: tenantB },
    },
  ) => ({
    id: eventId(),
    object: 'event',
    type: eventType,
    created: 1780000000, // deliberately older than current provider state
    livemode: false,
    data: { object: data },
  });
  const store = async (event: ReturnType<typeof payload>) => {
    await db.stripeWebhookEvent.create({
      data: {
        eventId: event.id, eventType: event.type,
        providerCreatedAt: new Date(event.created * 1000),
        payloadSha256: 'a'.repeat(64),
        payload: JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue,
        livemode: false,
      },
    });
    return event.id;
  };
  const providerState = (overrides: Record<string, unknown> = {}): unknown => ({
    id: providerId,
    object: 'subscription',
    livemode: false,
    customer: customerId,
    status: 'active',
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      object: 'list',
      data: [{
        id: 'si_' + pid(),
        price: { id: priceId },
        current_period_start: start,
        current_period_end: end,
      }],
      has_more: false,
    },
    ...overrides,
  });
  let currentProvider: unknown = providerState();
  let providerCalls = 0;
  const provider = {
    retrieve: async (id: string) => {
      providerCalls++;
      assert.equal(id, providerId);
      return currentProvider;
    },
  };
  try {
    assert.throws(() => new StripeTestSubscriptionReader('sk_live_' + pid()));
    assert.throws(() => new StripeTestSubscriptionReader('sk_test_short'));
    assert.equal(stripeTestSubscriptionSnapshot(providerState({
      current_period_start: start, current_period_end: end,
      items: { data: [{ price: { id: priceId } }] },
    })), null, 'top-level billing periods must not be accepted');
    assert.equal(stripeTestSubscriptionSnapshot(providerState({
      items: { data: [
        { price: { id: priceId }, current_period_start: start, current_period_end: end },
        { price: { id: priceId }, current_period_start: start, current_period_end: end },
      ] },
    })), null, 'a single local price cannot represent multiple Stripe billing items');

    await db.tenant.create({
      data: { id: tenantA, name: 'Known', countryCode: 'PT', timezone: 'Europe/Lisbon' },
    });
    await db.tenant.create({
      data: { id: tenantB, name: 'Not owned', countryCode: 'PT', timezone: 'Europe/Lisbon' },
    });
    await db.billingPlan.create({ data: { id: planId, ...planData } });
    await db.tenantSubscription.create({
      data: {
        id: subscriptionId, tenantId: tenantA, planId,
        provider: 'stripe', providerCustomerId: customerId,
        providerSubscriptionId: providerId, status: 'incomplete',
        currentPeriodStart: new Date((start - 86400) * 1000),
        currentPeriodEnd: new Date(start * 1000),
      },
    });
    const firstEvent = await store(payload());
    const first = await reconcileStoredStripeTestEvent(db, firstEvent, provider);
    assert.deepEqual(first, { outcome: 'applied', reason: 'provider_current' });
    let row = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenantA } });
    assert.equal(row.status, 'active');
    assert.equal(row.currentPeriodStart.toISOString(), new Date(start * 1000).toISOString());
    assert.equal(row.currentPeriodEnd.toISOString(), new Date(end * 1000).toISOString());
    assert.equal((await db.tenantSubscription.count({ where: { tenantId: tenantB } })), 0);
    const successful = await db.stripeReconciliationAttempt.findFirstOrThrow({
      where: { eventId: firstEvent }, orderBy: { createdAt: 'desc' },
    });
    assert.equal(successful.tenantId, tenantA);
    assert.equal(successful.reason, 'provider_current');
    // Replays are idempotent and audit another attempt without creating rows.
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, firstEvent, provider), first);
    assert.equal(await db.tenantSubscription.count({ where: { tenantId: tenantA } }), 1);
    assert.equal(await db.stripeReconciliationAttempt.count({ where: { eventId: firstEvent } }), 2);

    // A late subscription.deleted event must not reverse provider's current state.
    currentProvider = providerState({ status: 'past_due', items: {
      data: [{ price: { id: priceId }, current_period_start: end, current_period_end: next }],
      has_more: false,
    } });
    const old = await store(payload('customer.subscription.deleted'));
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, old, provider),
      { outcome: 'applied', reason: 'provider_current' });
    row = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenantA } });
    assert.equal(row.status, 'past_due');
    assert.equal(row.currentPeriodStart.toISOString(), new Date(end * 1000).toISOString());

    // Invoice shape in modern Stripe API must use parent.subscription_details.
    const invoice = await store(payload('invoice.paid', {
      id: 'in_' + pid(),
      parent: { subscription_details: { subscription: providerId } },
      metadata: { tenant_id: tenantB },
    }));
    assert.equal((await reconcileStoredStripeTestEvent(db, invoice, provider)).outcome, 'applied');

    currentProvider = providerState({ customer: 'cus_' + pid() });
    const mismatch = await store(payload());
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, mismatch, provider),
      { outcome: 'rejected', reason: 'provider_mismatch' });
    currentProvider = providerState({ items: { data: [{
      price: { id: 'price_' + pid() }, current_period_start: start, current_period_end: end,
    }], has_more: false } });
    const changedPrice = await store(payload());
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, changedPrice, provider),
      { outcome: 'rejected', reason: 'price_mismatch' });
    currentProvider = providerState({ livemode: true });
    const liveProvider = await store(payload());
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, liveProvider, provider),
      { outcome: 'rejected', reason: 'invalid_provider_snapshot' });
    currentProvider = providerState({ items: {
      data: [{ price: { id: priceId }, current_period_start: start, current_period_end: start }],
      has_more: false,
    } });
    const invalidPeriod = await store(payload());
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, invalidPeriod, provider),
      { outcome: 'rejected', reason: 'invalid_provider_snapshot' });

    const beforeUnknown = providerCalls;
    const unknown = await store(payload('customer.subscription.updated', {
      id: 'sub_' + pid(), customer: customerId,
      metadata: { tenant_id: tenantA, plan_id: planId },
    }));
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, unknown, provider),
      { outcome: 'unmapped', reason: 'no_known_subscription' });
    assert.equal(providerCalls, beforeUnknown, 'unbound subscriptions never trigger provider requests');

    const missingReference = await store(payload('invoice.payment_failed', {
      id: 'in_' + pid(),
      subscription: providerId, // intentionally obsolete top-level field
    }));
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, missingReference, provider),
      { outcome: 'rejected', reason: 'event_not_reconcilable' });

    const providerError = await store(payload());
    assert.deepEqual(await reconcileStoredStripeTestEvent(db, providerError, {
      retrieve: async () => { throw new Error('secret provider stacktrace'); },
    }), { outcome: 'deferred', reason: 'provider_unavailable' });

    row = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: tenantA } });
    assert.equal(row.status, 'past_due', 'reject/defer paths cannot overwrite a previous verified state');
    assert.equal(row.planId, planId);
    assert.equal(row.providerCustomerId, customerId);
    assert.equal(await db.stripeReconciliationAttempt.count({
      where: { tenantId: tenantB },
    }), 0, 'signed metadata cannot create an audit binding to another tenant');
    const [rights] = await db.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname='stripe_reconciliation_attempts'`;
    assert(rights?.enabled && rights.forced);
    const [access] = await db.$queryRaw<Array<{
      canRead: boolean; canWrite: boolean; canUpdate: boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime','stripe_reconciliation_attempts','SELECT')
        AS "canRead",
      has_table_privilege('melissa_runtime','stripe_reconciliation_attempts','INSERT')
        AS "canWrite",
      has_table_privilege('melissa_runtime','stripe_reconciliation_attempts','UPDATE')
        AS "canUpdate"`;
    assert.deepEqual(access, { canRead: false, canWrite: false, canUpdate: false });
    const events = await db.stripeWebhookEvent.findMany({
      where: { eventId: { in: [firstEvent, old, invoice, mismatch] } },
      select: { status: true },
    });
    assert(events.every((e) => e.status === 'received'), 'inbox evidence remains immutable');
  } finally {
    await db.$disconnect();
  }
});
