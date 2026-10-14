import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseStripeTestPaymentRisk, StripeTestPaymentRiskReader,
} from '../src/billing/stripe-test-payment-risk';

const now=1780000000;
const expected={
  invoiceId:'in_test123',customerId:'cus_test123',
  subscriptionId:'sub_test123',currency:'EUR',
  amountPaidMinor:1999n,paidAt:new Date(now*1000),
};
const invoice={
  object:'invoice',id:expected.invoiceId,livemode:false,status:'paid',
  paid:true,paid_out_of_band:false,collection_method:'charge_automatically',
  customer:expected.customerId,currency:'eur',amount_paid:1999,
  total:1999,amount_remaining:0,
  parent:{subscription_details:{subscription:expected.subscriptionId}},
  status_transitions:{paid_at:now},
};
const payments={
  object:'list',has_more:false,data:[{
    object:'invoice_payment',invoice:expected.invoiceId,livemode:false,
    status:'paid',currency:'eur',amount_paid:1999,
    payment:{type:'payment_intent',payment_intent:'pi_test123'},
  }],
};
const pi={
  object:'payment_intent',id:'pi_test123',livemode:false,
  status:'succeeded',customer:expected.customerId,currency:'eur',
  amount_received:1999,latest_charge:'ch_test123',
};
const charge={
  object:'charge',id:'ch_test123',livemode:false,
  payment_intent:pi.id,customer:expected.customerId,currency:'eur',
  amount:1999,paid:true,captured:true,status:'succeeded',
};
const list=(data:unknown[]=[],has_more=false)=>({object:'list',data,has_more});
const refund=(status='succeeded',amount=300)=>({
  object:'refund',id:'re_test123',livemode:false,
  charge:charge.id,payment_intent:pi.id,
  currency:'eur',status,amount,
});
const dispute=(status='needs_response')=>({
  object:'dispute',id:'du_test123',livemode:false,
  charge:charge.id,payment_intent:pi.id,
  currency:'eur',status,amount:300,
});
const parse=(r:unknown=list(),d:unknown=list(),
  overrides:{
    invoice?:object;payments?:object;pi?:object;charge?:object;
  }={})=>parseStripeTestPaymentRisk(
    {...invoice,...overrides.invoice},
    {...payments,...overrides.payments},
    {...pi,...overrides.pi},
    {...charge,...overrides.charge},
    r,d,expected,
  );

// prettier-ignore
test('risk snapshots are observations, not clearance, with stable replay hashes',()=>{
  const empty=parse();
  assert.equal(empty.outcome,'valid');
  if(empty.outcome!=='valid') throw new Error('missing valid snapshot');
  assert.equal(empty.snapshot.refundCount,0);
  assert.equal(empty.snapshot.disputeCount,0);
  assert.equal(empty.snapshot.succeededRefundMinor,0n);
  const one=parse(list([refund('pending',300)]),list([dispute()]));
  assert.equal(one.outcome,'valid');
  if(one.outcome!=='valid') throw new Error('missing risk');
  assert.equal(one.snapshot.refundCount,1);
  assert.equal(one.snapshot.pendingRefundMinor,300n);
  assert.equal(one.snapshot.succeededRefundMinor,0n);
  assert.equal(one.snapshot.unresolvedDisputeCount,1);
  assert.notEqual(one.snapshot.snapshotSha256,empty.snapshot.snapshotSha256);
  const changed=parse(list([refund('succeeded',300)]),list([dispute('won')]));
  assert.equal(changed.outcome,'valid');
  if(changed.outcome==='valid') {
    assert.notEqual(changed.snapshot.snapshotSha256,one.snapshot.snapshotSha256);
    assert.equal(changed.snapshot.succeededRefundMinor,300n);
    assert.equal(changed.snapshot.unresolvedDisputeCount,0);
  }
});

// prettier-ignore
test('cross-tenant, mixed charges, pagination and status spoofing are refused',()=>{
  const invalid:Array<{expected:string;value:ReturnType<typeof parse>}>= [
    {expected:'invoice_mismatch',value:parse(list(),list(),{invoice:{livemode:true}})},
    {expected:'payment_mapping_invalid',value:parse(list(),list(),
      {payments:{data:[{...payments.data[0],invoice:'in_foreign'}]}})},
    {expected:'payment_mapping_incomplete',value:parse(list(),list(),
      {payments:{has_more:true}})},
    {expected:'charge_mismatch',value:parse(list(),list(),
      {pi:{customer:'cus_foreign'}})},
    {expected:'charge_mismatch',value:parse(list(),list(),
      {charge:{customer:'cus_foreign'}})},
    {expected:'charge_mismatch',value:parse(list(),list(),
      {charge:{paid:false}})},
    {expected:'incomplete_risk_data',value:parse(list([],true))},
    {expected:'incomplete_risk_data',value:parse(list(),list([],true))},
    {expected:'invalid_refund_list',value:parse(list([
      {...refund(),charge:'ch_foreign'}]))},
    {expected:'invalid_refund_list',value:parse(list([
      refund(),refund()]))},
    {expected:'invalid_refund_list',value:parse(list([
      refund('succeeded',2000)]))},
    {expected:'invalid_dispute_list',value:parse(list(),list([
      {...dispute(),charge:'ch_foreign'}]))},
    {expected:'invalid_dispute_list',value:parse(list(),list([
      {...dispute(),status:'impossible'}]))},
    {expected:'invalid_dispute_list',value:parse(list(),list([
      dispute(),dispute()]))},
  ];
  for(const item of invalid) assert.equal(item.value.outcome,item.expected);
});

// prettier-ignore
test('risk provider uses only fixed Stripe TEST GET endpoints with bounded inputs',async()=>{
  assert.throws(()=>new StripeTestPaymentRiskReader('sk_live_unsafe'));
  const key='sk_test_'+'a'.repeat(32);
  const calls:string[]=[];
  const reader=new StripeTestPaymentRiskReader(key,async(input,init)=>{
    calls.push(String(input));
    assert.equal(init?.method,'GET');
    assert.equal(init?.redirect,'error');
    const headers=init?.headers as Record<string,string>;
    assert.equal(headers.Authorization,'Bearer '+key);
    assert.equal(headers['Stripe-Version'],'2025-09-30.clover');
    return new Response(JSON.stringify(list()),{
      status:200,headers:{'content-type':'application/json'},
    });
  });
  await reader.listInvoicePayments('in_test123');
  await reader.retrievePaymentIntent('pi_test123');
  await reader.retrieveCharge('ch_test123');
  await reader.listRefunds('ch_test123');
  await reader.listDisputes('ch_test123');
  assert.deepEqual(calls,[
    'https://api.stripe.com/v1/invoice_payments?invoice=in_test123&limit=100',
    'https://api.stripe.com/v1/payment_intents/pi_test123',
    'https://api.stripe.com/v1/charges/ch_test123',
    'https://api.stripe.com/v1/refunds?charge=ch_test123&limit=100',
    'https://api.stripe.com/v1/disputes?charge=ch_test123&limit=100',
  ]);
  await assert.rejects(reader.listRefunds('ch_X?charge=other'));
  await assert.rejects(reader.retrievePaymentIntent('https://evil'));
  assert.equal(calls.length,5);
});
