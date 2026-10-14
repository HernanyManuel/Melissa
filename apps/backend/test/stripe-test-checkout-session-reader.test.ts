import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  stripeTestCheckoutSessionSnapshot,
  StripeTestCheckoutSessionReader,
} from '../src/billing/stripe-test-checkout-session-reader';

const id = 'cs_test_123456789';
const reference = '198c417a-7123-4219-8d6c-8b2d62fc9170';
const fixture = {
  object: 'checkout.session',
  id,
  livemode: false,
  mode: 'subscription',
  status: 'complete',
  payment_status: 'paid',
  client_reference_id: reference,
  customer: 'cus_123456',
  subscription: 'sub_98765',
  created: 1780000000,
  expires_at: 1780003600,
};

test('Stripe test Checkout session parser never trusts incomplete or unpaid state', () => {
  const parsed = stripeTestCheckoutSessionSnapshot(fixture);
  assert(parsed);
  assert.equal(parsed.paid, true);
  assert.equal(parsed.reference, reference);
  for (const bad of [
    { livemode: true },
    { status: 'open' },
    { mode: 'payment' },
    { id: 'cs_live_123' },
    { customer: null },
    { client_reference_id: null },
    { subscription: null },
    { expires_at: 100 },
  ]) {
    assert.equal(stripeTestCheckoutSessionSnapshot({ ...fixture, ...bad }), null);
  }
  for (const payment of ['unpaid', 'no_payment_required']) {
    const pending = stripeTestCheckoutSessionSnapshot({
      ...fixture,
      payment_status: payment,
    });
    assert(pending);
    assert.equal(pending.paid, false);
  }
});

test('Checkout reader uses test credentials, bounded fixed-origin GET and no redirects', async () => {
  assert.throws(() => new StripeTestCheckoutSessionReader('sk_live_invalid'));
  const key = 'sk_test_' + 'a'.repeat(32);
  let invoked = 0;
  const reader = new StripeTestCheckoutSessionReader(key, async (url, init) => {
    invoked++;
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions/' + id);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>)['Stripe-Version'], '2025-09-30.clover');
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.deepEqual(await reader.retrieveSession(id), fixture);
  assert.equal(invoked, 1);
  await assert.rejects(reader.retrieveSession('cs_live_bad'));
  assert.equal(invoked, 1);
  await assert.rejects(
    new StripeTestCheckoutSessionReader(
      key,
      async () => new Response('unavailable', { status: 503 }),
    ).retrieveSession(id),
  );
});
