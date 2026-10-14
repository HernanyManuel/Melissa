import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config';
import { StripeTestPortalProvider } from '../src/billing/stripe-test-portal-provider';

const key = 'sk_test_' + 'a'.repeat(32);
const now = Math.floor(Date.now() / 1000);
const input = {
  customerId: 'cus_C123',
  subscriptionId: 'sub_S123',
  priceId: 'price_P123',
  configurationId: 'bpc_B123',
  origin: 'http://localhost:8080',
  tenantId: 'ee0e95b9-05ac-4871-a44d-404ac76c01ed',
};
const subscription = {
  object: 'subscription',
  livemode: false,
  id: input.subscriptionId,
  customer: input.customerId,
  status: 'active',
  trial_end: null,
  cancel_at_period_end: false,
  items: {
    data: [
      {
        price: { id: input.priceId },
        current_period_start: now - 60,
        current_period_end: now + 86400,
      },
    ],
    has_more: false,
  },
};
const configuration = {
  object: 'billing_portal.configuration',
  id: input.configurationId,
  active: true,
  livemode: false,
  login_page: { enabled: false },
  features: {
    invoice_history: { enabled: true },
    customer_update: { enabled: false },
    subscription_update: { enabled: false },
    subscription_cancel: { enabled: false },
    payment_method_update: { enabled: false },
  },
};
const session = {
  id: 'bps_test_X123',
  object: 'billing_portal.session',
  livemode: false,
  customer: input.customerId,
  configuration: input.configurationId,
  return_url: input.origin + '/billing/' + input.tenantId + '?portal=return',
  url: 'https://billing.stripe.com/p/session/test_ABC123',
  created: now,
};
function adapter(overrides: { sub?: object; config?: object; portal?: object } = {}) {
  const calls: string[] = [];
  const http: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert(String(url).startsWith('https://api.stripe.com/v1/'));
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['Stripe-Version'], '2025-09-30.clover');
    let payload: unknown;
    if (String(url).includes('/subscriptions/')) payload = { ...subscription, ...overrides.sub };
    else if (String(url).includes('/configurations/'))
      payload = { ...configuration, ...overrides.config };
    else {
      const form = new URLSearchParams(init?.body as string);
      assert.equal(form.get('customer'), input.customerId);
      assert.equal(form.get('configuration'), input.configurationId);
      assert.equal(form.get('return_url'), session.return_url);
      assert.equal([...form.keys()].length, 3);
      payload = { ...session, ...overrides.portal };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { gateway: new StripeTestPortalProvider(key, http), calls };
}

test('Stripe test Portal opt-in requires test credentials, configuration and safe origin', () => {
  const base = {
    DATABASE_URL: 'postgresql://localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
  };
  assert.equal(parseConfig(base).STRIPE_TEST_PORTAL_ENABLED, 'false');
  assert.throws(() => parseConfig({ ...base, STRIPE_TEST_PORTAL_ENABLED: 'true' }));
  assert.throws(() =>
    parseConfig({
      ...base,
      NODE_ENV: 'development',
      STRIPE_TEST_PORTAL_ENABLED: 'true',
      STRIPE_TEST_SECRET_KEY: key,
      STRIPE_TEST_PORTAL_CONFIGURATION_ID: input.configurationId,
      STRIPE_TEST_CHECKOUT_RETURN_ORIGIN: input.origin,
    }),
  );
  assert.equal(
    parseConfig({
      ...base,
      NODE_ENV: 'test',
      STRIPE_TEST_PORTAL_ENABLED: 'true',
      STRIPE_TEST_SECRET_KEY: key,
      STRIPE_TEST_PORTAL_CONFIGURATION_ID: input.configurationId,
      STRIPE_TEST_CHECKOUT_RETURN_ORIGIN: input.origin,
    }).STRIPE_TEST_PORTAL_ENABLED,
    'true',
  );
  assert.throws(() => new StripeTestPortalProvider('sk_live_bad'));
});

test('Stripe TEST Portal provider never opens a mutable, cross-customer or live session', async () => {
  const ok = adapter();
  assert.deepEqual(await ok.gateway.open(input), { url: session.url });
  assert.equal(ok.calls.length, 3);
  for (const bad of [
    { features: { ...configuration.features, subscription_cancel: { enabled: true } } },
    { features: { ...configuration.features, subscription_update: { enabled: true } } },
    { features: { ...configuration.features, customer_update: { enabled: true } } },
    { features: { ...configuration.features, payment_method_update: { enabled: true } } },
    { features: { ...configuration.features, another_feature: { enabled: true } } },
    { login_page: { enabled: true } },
    { livemode: true },
    { active: false },
  ]) {
    const x = adapter({ config: bad });
    await assert.rejects(x.gateway.open(input));
    assert.equal(x.calls.length, 2, 'no portal POST with mutable configuration');
  }
  for (const bad of [
    { livemode: true },
    { customer: 'cus_foreign' },
    { status: 'canceled' },
    { items: { data: [], has_more: false } },
  ]) {
    const x = adapter({ sub: bad });
    await assert.rejects(x.gateway.open(input));
    assert.equal(x.calls.length, 1);
  }
  for (const bad of [
    { livemode: true },
    { customer: 'cus_foreign' },
    { configuration: 'bpc_other' },
    { return_url: 'https://evil.example' },
    { url: 'https://evil.example/p/session/test_X' },
    { url: 'https://billing.stripe.com/p/session/live_X' },
    { url: 'https://billing.stripe.com/p/session/test_X?token=x' },
  ])
    await assert.rejects(adapter({ portal: bad }).gateway.open(input));
  await assert.rejects(adapter().gateway.open({ ...input, customerId: 'bad' }));
});
