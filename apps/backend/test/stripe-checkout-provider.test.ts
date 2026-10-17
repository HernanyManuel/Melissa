import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minorUnits,
  StripeTestCheckoutProvider,
} from '../src/billing/stripe-test-checkout-provider';

const key = 'sk_test_' + 'a'.repeat(32);
const plan = {
  priceId: 'price_Test123',
  productId: 'prod_Test123',
  amount: '19.990000',
  currency: 'EUR',
  interval: 'month',
};
const price = {
  id: plan.priceId,
  object: 'price',
  livemode: false,
  active: true,
  type: 'recurring',
  product: plan.productId,
  currency: 'eur',
  billing_scheme: 'per_unit',
  unit_amount: 1999,
  recurring: { interval: 'month', usage_type: 'licensed', interval_count: 1 },
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('catalog amounts are exact EUR/USD minor units; fractional cents fail', () => {
  assert.equal(minorUnits('19.990000'), 1999);
  assert.equal(minorUnits('0.01'), 1);
  for (const value of ['0', '1.001', '1e3', '-1', '100000000000', 'foo']) {
    assert.equal(minorUnits(value), null, value);
  }
});

test('Stripe test price validates recurring product, currency, amount and live mode', async () => {
  const http: typeof fetch = async () => response(price);
  await new StripeTestCheckoutProvider(key, http).validatePrice(plan);
  for (const bad of [
    { ...price, livemode: true },
    { ...price, currency: 'usd' },
    { ...price, unit_amount: 1 },
    { ...price, product: 'prod_foreign' },
    { ...price, recurring: { ...price.recurring, usage_type: 'metered' } },
  ]) {
    await assert.rejects(
      new StripeTestCheckoutProvider(key, async () => response(bad)).validatePrice(plan),
    );
  }
  assert.throws(() => new StripeTestCheckoutProvider('sk_live_do_not_use'));
  await assert.rejects(
    new StripeTestCheckoutProvider(key, http).validatePrice({ ...plan, amount: '1.001' }),
  );
});

test('Checkout creates only test hosted sessions with a server-owned return URL', async () => {
  const expiresAt = new Date(Math.floor((Date.now() + 3600000) / 1000) * 1000);
  const params: string[] = [];
  const http: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['Stripe-Version'], '2025-09-30.clover');
    assert.equal(headers['Idempotency-Key'], 'melissa-test-checkout-intent_1');
    const form = new URLSearchParams(init?.body as string);
    params.push(form.get('mode')!, form.get('line_items[0][price]')!);
    assert.equal(form.get('expires_at'), String(expiresAt.getTime() / 1000));
    assert.equal(form.get('client_reference_id'), 'intent_1');
    assert.equal(form.get('success_url'), 'http://localhost:8080/billing/tenant_1?checkout=return');
    return response({
      object: 'checkout.session',
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      client_reference_id: 'intent_1',
      mode: 'subscription',
      status: 'open',
      livemode: false,
      expires_at: expiresAt.getTime() / 1000,
    });
  };
  const args = {
    intentId: 'intent_1',
    tenantId: 'tenant_1',
    priceId: plan.priceId,
    origin: 'http://localhost:8080',
    expiresAt,
  };
  const result = await new StripeTestCheckoutProvider(key, http).createSession(args);
  assert.equal(result.id, 'cs_test_123');
  assert.deepEqual(params, ['subscription', plan.priceId]);
  for (const variant of [
    { livemode: true },
    { client_reference_id: 'another_tenant' },
    { url: 'https://example.com/checkout' },
    { mode: 'payment' },
  ]) {
    const body = {
      object: 'checkout.session',
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      client_reference_id: 'intent_1',
      mode: 'subscription',
      status: 'open',
      livemode: false,
      expires_at: expiresAt.getTime() / 1000,
      ...variant,
    };
    await assert.rejects(
      new StripeTestCheckoutProvider(key, async () => response(body)).createSession(args),
    );
  }
});
