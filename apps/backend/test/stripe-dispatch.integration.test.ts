import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  claimStripeTestEvent, dispatchOneStripeTestEvent, dispatchRetrySeconds,
} from '../src/billing/stripe-test-dispatcher';

const pid = () => randomUUID().replace(/-/g, '');
const eid = () => 'evt_' + pid();

// Real PostgreSQL grants/RLS, INSERT trigger, leases and transactional audits;
// external Stripe is deliberately simulated. No production payment path.
// prettier-ignore
test('signed Stripe dispatch: atomic queue, bounded retries, lock reclaim and verified link/reconcile', { timeout: 60000 }, async () => {
  const adminUrl = process.env.MIGRATION_DATABASE_URL;
  const dispatchUrl = process.env.BILLING_DISPATCHER_DATABASE_URL;
  const linkerUrl = process.env.BILLING_LINKER_DATABASE_URL;
  const reconcileUrl = process.env.BILLING_RECONCILER_DATABASE_URL;
  assert(adminUrl && dispatchUrl && linkerUrl && reconcileUrl);
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  const dispatcher = new PrismaClient({ datasources: { db: { url: dispatchUrl } } });
  const linker = new PrismaClient({ datasources: { db: { url: linkerUrl } } });
  const reconciler = new PrismaClient({ datasources: { db: { url: reconcileUrl } } });
  const databases = { dispatcher, linker, reconciler };
  const tenantId = randomUUID();
  const planId = randomUUID();
  const intentId = randomUUID();
  const sessionId = 'cs_test_' + pid();
  const priceId = 'price_' + pid();
  const customerId = 'cus_' + pid();
  const subscriptionId = 'sub_' + pid();
  const start = Math.floor(Date.now() / 1000) - 60;
  const end = start + 30 * 86400;
  let checkout: Record<string, unknown>;
  let subscription: Record<string, unknown>;
  let checkoutFailure = false;
  const providers = {
    checkout: {
      retrieveSession: async (id: string) => {
        assert.equal(id, sessionId);
        if (checkoutFailure) throw new Error('do not leak provider secrets');
        return checkout;
      },
      retrieveSubscription: async (id: string) => {
        assert.equal(id, subscriptionId);
        return subscription;
      },
    },
    subscription: {
      retrieve: async (id: string) => {
        assert.equal(id, subscriptionId);
        return subscription;
      },
    },
  };
  const store = async (type: string, object: Record<string, unknown>) => {
    const eventId = eid();
    await admin.stripeWebhookEvent.create({
      data: {
        eventId, eventType: type, livemode: false,
        providerCreatedAt: new Date(), payloadSha256: 'b'.repeat(64),
        payload: {
          id: eventId, object: 'event', type, livemode: false,
          data: { object },
        } as Prisma.InputJsonValue,
      },
    });
    return eventId;
  };
  const run = (eventId: string) =>
    dispatchOneStripeTestEvent(databases, providers, eventId);
  const due = (eventId: string) =>
    admin.stripeEventDispatch.update({
      where: { eventId }, data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
  try {
    assert.equal(dispatchRetrySeconds(1), 30);
    assert.equal(dispatchRetrySeconds(2), 120);
    assert.equal(dispatchRetrySeconds(3), 480);
    assert.equal(dispatchRetrySeconds(6), 1800);
    assert.throws(() => dispatchRetrySeconds(7));
    await admin.tenant.create({
      data: { id: tenantId, name: 'Dispatch isolated tenant',
        countryCode: 'PT', timezone: 'Europe/Lisbon' },
    });
    await admin.billingPlan.create({
      data: {
        id: planId, key: 'dispatch-' + pid(), name: 'Dispatch price',
        currency: 'EUR', basePrice: '19.990000',
        billingInterval: 'month', includedConversations: 10,
        includedMessages: null, includedStaff: 1, includedChannels: 1,
        includedLocations: 1, overagePricePerConversation: '0', features: {},
        stripeProductId: 'prod_' + pid(), stripePriceId: priceId, active: true,
      },
    });
    const intent = await admin.stripeCheckoutIntent.create({
      data: {
        id: intentId, tenantId, planId, requestId: randomUUID(),
        stripePriceId: priceId, status: 'ready', checkoutSessionId: sessionId,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/' + sessionId,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    checkout = {
      id: sessionId, object: 'checkout.session', livemode: false,
      mode: 'subscription', status: 'complete', payment_status: 'paid',
      client_reference_id: intentId, customer: customerId,
      subscription: subscriptionId,
      created: Math.floor(intent.createdAt.getTime() / 1000),
      expires_at: Math.floor(intent.expiresAt.getTime() / 1000),
    };
    subscription = {
      id: subscriptionId, object: 'subscription', livemode: false,
      status: 'active', customer: customerId, trial_end: null,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: priceId },
        current_period_start: start, current_period_end: end }], has_more: false },
    };
    const completed = await store('checkout.session.completed', {
      id: sessionId, object: 'checkout.session',
      metadata: { tenant_id: randomUUID(), plan_id: randomUUID() },
    });
    const enqueued = await admin.stripeEventDispatch.findUniqueOrThrow({
      where: { eventId: completed },
    });
    assert.equal(enqueued.state, 'pending');
    assert.equal(enqueued.attempts, 0);
    await assert.rejects(claimStripeTestEvent(admin, completed),
      /Dedicated Stripe dispatcher role required/);

    checkoutFailure = true;
    assert.deepEqual(await run(completed), {
      eventId: completed, attempt: 1, action: 'retry', reason: 'provider_unavailable',
    });
    assert.equal(await run(completed), null, 'backoff prevents immediate replay');
    let queue = await admin.stripeEventDispatch.findUniqueOrThrow({
      where: { eventId: completed },
    });
    assert.equal(queue.state, 'pending');
    assert(queue.nextAttemptAt > new Date());
    await due(completed);
    checkoutFailure = false;
    assert.deepEqual(await run(completed), {
      eventId: completed, attempt: 2, action: 'complete', reason: 'linked',
    });
    const linked = await admin.tenantSubscription.findUniqueOrThrow({
      where: { tenantId },
    });
    assert.equal(linked.providerSubscriptionId, subscriptionId);
    assert.equal(linked.checkoutSessionId, sessionId);
    assert.equal(await run(completed), null);
    const log = await admin.stripeDispatchAttempt.findMany({
      where: { eventId: completed }, orderBy: { createdAt: 'asc' },
    });
    assert.equal(log.length, 4);
    assert.deepEqual(log.map((x) => x.action).sort(),
      ['claimed','claimed','complete','retry'].sort());

    const updated = await store('customer.subscription.updated', {
      id: subscriptionId, object: 'subscription',
      metadata: { tenant_id: randomUUID() },
    });
    subscription = { ...subscription, status: 'past_due' };
    assert.deepEqual(await run(updated), {
      eventId: updated, attempt: 1, action: 'complete', reason: 'applied',
    });
    const persisted = await admin.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    assert.equal(persisted.status, 'past_due');
    assert.equal(persisted.providerCustomerId, customerId);

    // Crash after claim: next worker cannot overlap the active lease;
    // when it expires, it can reclaim with a DIFFERENT fencing token.
    const staleEvent = await store('customer.subscription.updated', {
      id: 'sub_' + pid(), object: 'subscription',
    });
    const first = await claimStripeTestEvent(dispatcher, staleEvent);
    assert(first);
    assert.equal(first.attempts, 1);
    assert.equal(await claimStripeTestEvent(dispatcher, staleEvent), null);
    await admin.stripeEventDispatch.update({
      where: { eventId: staleEvent }, data: { leaseUntil: new Date(Date.now()-1000) },
    });
    const second = await claimStripeTestEvent(dispatcher, staleEvent);
    assert(second);
    assert.equal(second.attempts, 2);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.deepEqual(await run(staleEvent), null, 'second worker holds the new lease');

    // A separate, unmapped event exhausts retries and becomes terminal
    // without creating any subscription or ever granting entitlements.
    const unmapped = await store('customer.subscription.created', {
      id: 'sub_' + pid(), object: 'subscription',
      metadata: { tenant_id: tenantId },
    });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const res = await run(unmapped);
      assert(res);
      assert.equal(res.attempt, attempt);
      assert.equal(res.action, attempt===6 ? 'dead' : 'retry');
      if (attempt<6) await due(unmapped);
    }
    assert.equal(await run(unmapped), null);
    queue = await admin.stripeEventDispatch.findUniqueOrThrow({ where: { eventId: unmapped } });
    assert.equal(queue.state, 'dead');
    assert.equal(queue.attempts, 6);

    // Runtime can insert only through the signed inbox; dispatcher has no
    // subscription, tenant or immutable event payload privileges.
    const [privileges] = await admin.$queryRaw<Array<{
      runtimeCanQueue: boolean; dispatcherCanInsert: boolean;
      dispatcherCanReadEvent: boolean; dispatcherCanReadTenant: boolean;
      dispatcherCanReadSub: boolean; linkerCanDispatch: boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime','stripe_event_dispatch','SELECT')
        AS "runtimeCanQueue",
      has_table_privilege('melissa_billing_dispatcher','stripe_event_dispatch','INSERT')
        AS "dispatcherCanInsert",
      has_column_privilege('melissa_billing_dispatcher','stripe_webhook_events',
        'payload','SELECT') AS "dispatcherCanReadEvent",
      has_table_privilege('melissa_billing_dispatcher','tenants','SELECT')
        AS "dispatcherCanReadTenant",
      has_table_privilege('melissa_billing_dispatcher','subscriptions','SELECT')
        AS "dispatcherCanReadSub",
      has_table_privilege('melissa_billing_linker','stripe_event_dispatch','SELECT')
        AS "linkerCanDispatch"`;
    assert.deepEqual(privileges, {
      runtimeCanQueue: false, dispatcherCanInsert: false,
      dispatcherCanReadEvent: false, dispatcherCanReadTenant: false,
      dispatcherCanReadSub: false, linkerCanDispatch: false,
    });
    const [rls] = await admin.$queryRaw<Array<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_event_dispatch'`;
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    await assert.rejects(dispatcher.stripeWebhookEvent.findFirst());
    await assert.rejects(dispatcher.tenantSubscription.findFirst());
    assert.equal(await admin.tenantSubscription.count({ where: { tenantId } }), 1);
  } finally {
    await Promise.all([
      admin.$disconnect(),dispatcher.$disconnect(),
      linker.$disconnect(),reconciler.$disconnect(),
    ]);
  }
});
