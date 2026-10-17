import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeAutomaticStripeTestPayout as observe } from '../src/billing/stripe-test-payout-observation';

const payout = { object: 'payout', id: 'po_test1', livemode: false,
  automatic: true, reconciliation_status: 'completed',
  status: 'paid', currency: 'eur', amount: 200 };
const expected = [
  { id: 'txn_one', source: 'ch_one', currency: 'eur', netMinor: 80 },
  { id: 'txn_two', source: 'ch_two', currency: 'eur', netMinor: 90 },
];
const rows = { object: 'list', has_more: false, data: [
  { object: 'balance_transaction', id: 'txn_one', source: 'ch_one', type: 'charge', currency: 'eur', net: 80 },
  { object: 'balance_transaction', id: 'txn_two', source: 'ch_two', type: 'payment', currency: 'eur', net: 90 },
]};
test('ADR-121: observes only complete automatic payout membership; never settles', () => {
  const result = observe(payout, rows, expected);
  assert.equal(result.outcome, 'observed');
  if (result.outcome === 'observed') {
    assert.equal(result.observedNetMinor, 170n);
    assert.equal(result.settlementVerified, false);
    assert.equal(result.billable, false);
    assert.equal(result.digest, (observe(payout, { ...rows, data: [...rows.data].reverse() }, [...expected].reverse()) as typeof result).digest);
  }
});
test('ADR-121: reject live, mismatched and duplicated balance transactions', () => {
  assert.equal(observe({ ...payout, livemode: true }, rows, expected).outcome, 'rejected');
  assert.equal(observe(payout, { ...rows, data: [rows.data[0], rows.data[0]] }, expected).outcome, 'rejected');
  assert.equal(observe(payout, { ...rows, data: [{ ...rows.data[0], source: 'ch_foreign' }, rows.data[1]] }, expected).outcome, 'rejected');
});
test('ADR-121: defer incomplete, manual and non-reconciled payouts', () => {
  assert.deepEqual(observe({ ...payout, automatic: false }, rows, expected),
    { outcome: 'deferred', reason: 'manual_payout_not_attributable' });
  assert.equal(observe({ ...payout, reconciliation_status: 'in_progress' }, rows, expected).outcome, 'deferred');
  assert.equal(observe(payout, { ...rows, has_more: true }, expected).outcome, 'deferred');
  assert.equal(observe(payout, { ...rows, data: [rows.data[0]] }, expected).outcome, 'deferred');
});
