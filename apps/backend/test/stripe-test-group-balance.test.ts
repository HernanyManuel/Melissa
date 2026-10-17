import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStripeTestGroupBalances } from '../src/billing/stripe-test-group-balance';
import { StripeTestGroupBalanceReader } from '../src/billing/stripe-group-balance-verifier';

const now = 1780000000;
const expected = {
  invoiceId: 'in_group_balance',
  customerId: 'cus_balance',
  subscriptionId: 'sub_balance',
  currency: 'EUR',
  amountPaidMinor: 1999n,
  paidAt: new Date(now * 1000),
};
const invoice = {
  object: 'invoice',
  id: expected.invoiceId,
  livemode: false,
  status: 'paid',
  paid: true,
  paid_out_of_band: false,
  collection_method: 'charge_automatically',
  customer: expected.customerId,
  currency: 'eur',
  amount_paid: 1999,
  total: 1999,
  amount_remaining: 0,
  parent: { subscription_details: { subscription: expected.subscriptionId } },
  status_transitions: { paid_at: now },
};
const payments = {
  object: 'list',
  has_more: false,
  data: [1000, 999].map((n, i) => ({
    object: 'invoice_payment',
    id: 'inpay_balance_' + i,
    invoice: expected.invoiceId,
    livemode: false,
    status: 'paid',
    currency: 'eur',
    amount_paid: n,
    payment: { type: 'payment_intent', payment_intent: 'pi_balance_' + i },
  })),
};
const links = () =>
  [1000, 999].map((n, i) => ({
    paymentIntent: {
      object: 'payment_intent',
      id: 'pi_balance_' + i,
      livemode: false,
      customer: expected.customerId,
      status: 'succeeded',
      currency: 'eur',
      amount_received: n,
      latest_charge: 'ch_balance_' + i,
    },
    charge: {
      object: 'charge',
      id: 'ch_balance_' + i,
      livemode: false,
      payment_intent: 'pi_balance_' + i,
      customer: expected.customerId,
      currency: 'eur',
      status: 'succeeded',
      paid: true,
      captured: true,
      amount: n,
      balance_transaction: 'txn_balance_' + i,
    },
    balanceTransaction: {
      object: 'balance_transaction',
      id: 'txn_balance_' + i,
      source: 'ch_balance_' + i,
      type: 'charge',
      status: i ? 'pending' : 'available',
      currency: 'eur',
      amount: n,
      fee: 100,
      net: n - 100,
      available_on: now + 86400,
    },
  }));
const parse = (l: ReturnType<typeof links> = links(), p: unknown = payments) =>
  parseStripeTestGroupBalances(invoice, p, l, expected);

// prettier-ignore
test('Stripe TEST grouped balance shows fees/net and changing availability only',()=>{
  const first=parse();
  assert.equal(first.outcome,'valid');
  if(first.outcome!=='valid')throw Error('missing snapshot');
  assert.equal(first.snapshot.chargeCount,2);
  assert.equal(first.snapshot.grossMinor,1999n);
  assert.equal(first.snapshot.feeMinor,200n);
  assert.equal(first.snapshot.netMinor,1799n);
  assert.equal(first.snapshot.availableCount,1);
  assert.equal(first.snapshot.pendingCount,1);
  const changed=links();
  changed[1]!.balanceTransaction.status='available';
  const second=parse(changed);
  assert.equal(second.outcome,'valid');
  if(second.outcome==='valid'){
    assert.equal(second.snapshot.availableCount,2);
    assert.notEqual(second.snapshot.balanceDigest,first.snapshot.balanceDigest);
    assert.equal(second.snapshot.groupDigest,first.snapshot.groupDigest);
  }
  const reorder=links().reverse();
  const reversed={...payments,data:[...payments.data].reverse()};
  const copy=parse(reorder,reversed);
  assert.equal(copy.outcome,'valid');
  if(copy.outcome==='valid')
    assert.equal(copy.snapshot.balanceDigest,first.snapshot.balanceDigest);
});

// prettier-ignore
test('balance Charge source and amount must be exact and payment graph complete',()=>{
  for(const modify of [
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.source='ch_foreign';},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.id='txn_foreign';},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.currency='usd';},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.fee=2000;},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.net=999;},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.amount=2;},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.status='settled';},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.type='transfer';},
    (l:ReturnType<typeof links>)=>{l[0]!.balanceTransaction.available_on=0;},
    (l:ReturnType<typeof links>)=>{
      l[1]!.balanceTransaction.id=l[0]!.balanceTransaction.id;
      l[1]!.charge.balance_transaction=l[0]!.charge.balance_transaction;
    },
  ]){
    const candidate=links();
    modify(candidate);
    assert.equal(parse(candidate).outcome,'invalid_balance_graph');
  }
  const absent=links();
  absent[0]!.charge.balance_transaction='';
  assert.equal(parse(absent).outcome,'balance_transaction_missing');
  assert.equal(parse(links(),{...payments,has_more:true}).outcome,'partial_list');
  const foreign=links();
  foreign[1]!.charge.customer='cus_foreign';
  assert.equal(parse(foreign).outcome,'invalid_payment_graph');
});

// prettier-ignore
test('balance reader only fetches fixed Stripe TEST resource, never accepts URL paths',async()=>{
  assert.throws(()=>new StripeTestGroupBalanceReader('sk_live_unsafe'));
  const key='sk_test_'+'a'.repeat(32);
  const urls:string[]=[];
  const reader=new StripeTestGroupBalanceReader(key,async(input,init)=>{
    urls.push(String(input));
    assert.equal(init?.method,'GET');
    assert.equal(init?.redirect,'error');
    const headers=init?.headers as Record<string,string>;
    assert.equal(headers.Authorization,'Bearer '+key);
    return new Response(JSON.stringify({object:'balance_transaction'}),{
      status:200,headers:{'content-type':'application/json'},
    });
  });
  await reader.retrieveBalanceTransaction('txn_balance_0');
  assert.deepEqual(urls,['https://api.stripe.com/v1/balance_transactions/txn_balance_0']);
  await assert.rejects(reader.retrieveBalanceTransaction('txn_id?ref=evil'));
  assert.equal(urls.length,1);
});
