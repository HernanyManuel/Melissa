import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.deepEqual(observe(payout,rows,[...expected,{...expected[0]!,id:'txn_bad'}]),
    {outcome:'deferred',reason:'group_not_fully_in_payout'});
});

// prettier-ignore
test('ADR-121: payout digest binds payout identity, membership and net without order dependence',()=>{
  const first=observe(payout,rows,expected);
  const another=observe({...payout,id:'po_other'},rows,expected);
  const changed=observe(payout,{...rows,data:[
    {...rows.data[0],net:79},rows.data[1],
  ]},[{...expected[0]!,netMinor:79},expected[1]!]);
  assert.equal(first.outcome,'observed');
  assert.equal(another.outcome,'observed');
  assert.equal(changed.outcome,'observed');
  if(first.outcome==='observed' && another.outcome==='observed' && changed.outcome==='observed'){
    assert.notEqual(first.digest,another.digest);
    assert.notEqual(first.digest,changed.digest);
    assert.equal(changed.observedNetMinor,169n);
    assert.equal(changed.settlementVerified,false);
    assert.equal(changed.billable,false);
  }
});

// prettier-ignore
test('ADR-121: equal net does not make a different Charge membership the same evidence',()=>{
  const original=observe(payout,rows,expected);
  const different=observe(payout,{...rows,data:[
    rows.data[0],{...rows.data[1],id:'txn_third',source:'ch_third'},
  ]},[expected[0]!,{...expected[1]!,id:'txn_third',source:'ch_third'}]);
  assert.equal(original.outcome,'observed');
  assert.equal(different.outcome,'observed');
  if(original.outcome==='observed' && different.outcome==='observed'){
    assert.equal(original.observedNetMinor,different.observedNetMinor);
    assert.notEqual(original.digest,different.digest);
    assert.equal(different.settlementVerified,false);
    assert.equal(different.billable,false);
  }
});

// prettier-ignore
test('ADR-121: unrelated account movements cannot change a validated group digest',()=>{
  const baseline=observe(payout,rows,expected);
  const unrelated={object:'balance_transaction',id:'txn_unrelated',
    source:'ch_unrelated',type:'charge',currency:'eur',net:150};
  const extra=observe(payout,{...rows,data:[unrelated,...rows.data]},expected);
  assert.equal(baseline.outcome,'observed');
  assert.equal(extra.outcome,'observed');
  if(baseline.outcome==='observed' && extra.outcome==='observed'){
    assert.equal(extra.digest,baseline.digest);
    assert.equal(extra.observedNetMinor,baseline.observedNetMinor);
    assert.equal(extra.includedCount,baseline.includedCount);
    assert.equal(extra.settlementVerified,false);
    assert.equal(extra.billable,false);
  }
});
