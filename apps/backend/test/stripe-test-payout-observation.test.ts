import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExpectedPayoutBalance } from '../src/billing/stripe-test-payout-observation';
import { observeAutomaticStripeTestPayout as observe } from '../src/billing/stripe-test-payout-observation';

// prettier-ignore
const payout = { object: 'payout', id: 'po_test1', livemode: false,
  automatic: true, reconciliation_status: 'completed',
  status: 'paid', currency: 'eur', amount: 200 };
// prettier-ignore
const expected = [
  { id: 'txn_one', source: 'ch_one', currency: 'eur', netMinor: 80 },
  { id: 'txn_two', source: 'ch_two', currency: 'eur', netMinor: 90 },
];
// prettier-ignore
const rows = { object: 'list', has_more: false, data: [
  { object: 'balance_transaction', id: 'txn_one', source: 'ch_one', type: 'charge', currency: 'eur', net: 80 },
  { object: 'balance_transaction', id: 'txn_two', source: 'ch_two', type: 'payment', currency: 'eur', net: 90 },
]};
// prettier-ignore
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
// prettier-ignore
test('ADR-121: reject live, mismatched and duplicated balance transactions', () => {
  assert.equal(observe({ ...payout, livemode: true }, rows, expected).outcome, 'rejected');
  assert.equal(observe(payout, { ...rows, data: [rows.data[0], rows.data[0]] }, expected).outcome, 'rejected');
  assert.equal(observe(payout, { ...rows, data: [{ ...rows.data[0], source: 'ch_foreign' }, rows.data[1]] }, expected).outcome, 'rejected');
});
// prettier-ignore
test('ADR-121: defer incomplete, manual and non-reconciled payouts', () => {
  assert.deepEqual(observe({ ...payout, automatic: false }, rows, expected),
    { outcome: 'deferred', reason: 'manual_payout_not_attributable' });
  assert.equal(observe({ ...payout, reconciliation_status: 'in_progress' }, rows, expected).outcome, 'deferred');
  assert.equal(observe(payout, { ...rows, has_more: true }, expected).outcome, 'deferred');
  assert.equal(observe(payout, { ...rows, data: [rows.data[0]] }, expected).outcome, 'deferred');
});

// prettier-ignore
test('ADR-121: rejects account-list duplicates and never guesses missing group membership', () => {
  const foreign={object:'balance_transaction',id:'txn_other',source:'ch_other',
    type:'charge',currency:'eur',net:100};
  assert.equal(observe(payout,{...rows,data:[...rows.data,foreign]},expected).outcome,'observed');
  assert.deepEqual(observe(payout,{...rows,data:[rows.data[0],foreign]},expected),
    {outcome:'deferred',reason:'group_not_fully_in_payout'});
  assert.deepEqual(observe(payout,{...rows,data:[...rows.data,foreign,foreign]},expected),
    {outcome:'rejected',reason:'invalid_transaction_list'});
  assert.deepEqual(observe(payout,{...rows,data:[...rows.data,{...foreign,id:'txn_bad?param=x'}]},expected),
    {outcome:'rejected',reason:'invalid_transaction_list'});
  assert.deepEqual(observe(payout,{...rows,data:[rows.data[0],{...rows.data[1],net:0}]},expected),
    {outcome:'rejected',reason:'transaction_mismatch'});
});

// prettier-ignore
test('ADR-121: fail closed for payout lifecycle, wrong currency and malformed financial data',()=>{
  const variants=[
    [{...payout,status:'pending'},'deferred'],
    [{...payout,status:'failed'},'deferred'],
    [{...payout,reconciliation_status:'not_applicable'},'deferred'],
    [{...payout,currency:'usd'},'rejected'],
    [{...payout,amount:-10},'rejected'],
    [{...payout,amount:Number.MAX_SAFE_INTEGER+1},'rejected'],
    [{...payout,livemode:undefined},'rejected'],
  ] as const;
  for(const [candidate,outcome] of variants)
    assert.equal(observe(candidate,rows,expected).outcome,outcome);
  assert.equal(observe(payout,{...rows,has_more:'false'},expected).outcome,'rejected');
  assert.equal(observe(payout,{...rows,data:'not a list'},expected).outcome,'rejected');
  assert.equal(observe(payout,rows,[expected[0]!,expected[0]!]).outcome,'rejected');
  assert.equal(observe(payout,rows,[...expected,{...expected[0]!,id:'txn_bad'}]).outcome,'rejected');
});
