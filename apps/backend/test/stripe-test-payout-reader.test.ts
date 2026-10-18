import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripeTestPayoutReader } from '../src/billing/stripe-test-payout-reader';

test('ADR-121 payout reader only sends GET to fixed Stripe TEST host', async () => {
  assert.throws(() => new StripeTestPayoutReader('sk_live_invalid'));
  const key = 'sk_test_' + 'a'.repeat(32);
  const urls: string[] = [];
  const reader = new StripeTestPayoutReader(key, async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + key);
    if (String(input).includes('/v1/payouts/')) {
      return new Response(JSON.stringify({ object: 'payout' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        object: 'list',
        has_more: false,
        data: [{ id: 'txn_test1', object: 'balance_transaction' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  await reader.retrievePayout('po_test1');
  await reader.listAutomaticPayoutTransactions('po_test1');
  assert.deepEqual(urls, [
    'https://api.stripe.com/v1/payouts/po_test1',
    'https://api.stripe.com/v1/balance_transactions?payout=po_test1&limit=100',
  ]);
  await assert.rejects(reader.retrievePayout('po_test1?expand[]=destination'));
  await assert.rejects(reader.listAutomaticPayoutTransactions('po_test1&limit=999'));
  assert.equal(urls.length, 2);
});

// prettier-ignore
test('ADR-121 payout pagination refuses incomplete cycles and duplicate cursor IDs', async () => {
  const key = 'sk_test_' + 'b'.repeat(32);
  const urls: string[] = [];
  // prettier-ignore
  const reader = new StripeTestPayoutReader(key, async (input) => {
    const url = String(input);
    urls.push(url);
    const id = 'txn_same';
    return new Response(JSON.stringify({
      object: 'list',
      has_more: true,
      data: [{ id, object: 'balance_transaction' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(
    reader.listAutomaticPayoutTransactions('po_cycle'),
    /Malformed or repeated Stripe TEST ID/,
  );
  assert(urls.length <= 3);
  assert(urls.every((url) => url.startsWith(
    'https://api.stripe.com/v1/balance_transactions?payout=po_cycle&limit=100',
  )));
});
