import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStripeTestGroupChargeRisk } from '../src/billing/stripe-test-group-charge-risk';

const now=1780000000;
const expected={
  invoiceId:'in_group',customerId:'cus_group',subscriptionId:'sub_group',
  currency:'EUR',amountPaidMinor:1999n,paidAt:new Date(now*1000),
};
const invoice={
  id:expected.invoiceId,object:'invoice',livemode:false,
  status:'paid',paid:true,paid_out_of_band:false,
  collection_method:'charge_automatically',customer:expected.customerId,
  currency:'eur',amount_paid:1999,total:1999,amount_remaining:0,
  parent:{subscription_details:{subscription:expected.subscriptionId}},
  status_transitions:{paid_at:now},
};
const pays=[1000,999].map((amount,i)=>({
  object:'invoice_payment',id:'inpay_group_'+i,invoice:expected.invoiceId,
  livemode:false,status:'paid',currency:'eur',amount_paid:amount,
  payment:{type:'payment_intent',payment_intent:'pi_group_'+i},
}));
const payments=(data:unknown[]=pays,has_more=false)=>({
  object:'list',has_more,data,
});
const empty=(data:unknown[]=[],has_more=false)=>({object:'list',data,has_more});
const links=()=>pays.map((pay,i)=>({
  paymentIntent:{
    object:'payment_intent',id:'pi_group_'+i,livemode:false,
    status:'succeeded',customer:expected.customerId,currency:'eur',
    amount_received:pay.amount_paid,latest_charge:'ch_group_'+i,
  },
  charge:{
    object:'charge',id:'ch_group_'+i,livemode:false,
    payment_intent:'pi_group_'+i,customer:expected.customerId,
    currency:'eur',status:'succeeded',paid:true,captured:true,
    amount:pay.amount_paid,
  },
  refunds:empty(),disputes:empty(),
}));
const refund=(i:number,status:string)=>({
  object:'refund',id:'re_group_'+i,livemode:false,
  charge:'ch_group_'+i,payment_intent:'pi_group_'+i,
  currency:'eur',amount:i===0?300:400,status,
});
const dispute=(i:number,status:string)=>({
  object:'dispute',id:'du_group_'+i,livemode:false,
  charge:'ch_group_'+i,payment_intent:'pi_group_'+i,
  currency:'eur',amount:i===0?300:400,status,
});

// prettier-ignore
test('multi-Charge risk snapshots aggregate all verified allocations, never clear payment',()=>{
  const zero=parseStripeTestGroupChargeRisk(invoice,payments(),links(),expected);
  assert.equal(zero.outcome,'valid');
  if(zero.outcome!=='valid') throw new Error('Expected valid group');
  assert.equal(zero.snapshot.chargeCount,2);
  assert.equal(zero.snapshot.refundCount,0);
  const rows=links();
  rows[0]!.refunds=empty([refund(0,'pending')]);
  rows[1]!.refunds=empty([refund(1,'succeeded')]);
  rows[1]!.disputes=empty([dispute(1,'under_review')]);
  const observed=parseStripeTestGroupChargeRisk(invoice,payments(),rows,expected);
  assert.equal(observed.outcome,'valid');
  if(observed.outcome!=='valid') throw new Error('Expected observations');
  assert.equal(observed.snapshot.refundCount,2);
  assert.equal(observed.snapshot.succeededRefundMinor,400n);
  assert.equal(observed.snapshot.pendingRefundMinor,300n);
  assert.equal(observed.snapshot.unresolvedDisputeCount,1);
  assert.notEqual(observed.snapshot.riskDigest,zero.snapshot.riskDigest);
  const replay=parseStripeTestGroupChargeRisk(invoice,payments(),rows,expected);
  assert.deepEqual(replay,observed);
  rows[0]!.refunds=empty([refund(0,'succeeded')]);
  const changed=parseStripeTestGroupChargeRisk(invoice,payments(),rows,expected);
  assert.equal(changed.outcome,'valid');
  if(changed.outcome==='valid')
    assert.notEqual(changed.snapshot.riskDigest,observed.snapshot.riskDigest);
});

// prettier-ignore
test('all Charges must be complete, linked and non-duplicated or review refuses',()=>{
  const incomplete=links();incomplete[1]!.refunds=empty([],true);
  assert.equal(parseStripeTestGroupChargeRisk(invoice,payments(),incomplete,expected).outcome,
    'incomplete_risk_data');
  const foreign=links();foreign[1]!.refunds=empty([{
    ...refund(1,'succeeded'),charge:'ch_foreign',
  }]);
  assert.equal(parseStripeTestGroupChargeRisk(invoice,payments(),foreign,expected).outcome,
    'invalid_risk_graph');
  const wrongDispute=links();wrongDispute[0]!.disputes=empty([{
    ...dispute(0,'needs_response'),payment_intent:'pi_foreign',
  }]);
  assert.equal(parseStripeTestGroupChargeRisk(invoice,payments(),wrongDispute,expected).outcome,
    'invalid_risk_graph');
  assert.equal(parseStripeTestGroupChargeRisk(invoice,payments(pays,true),links(),expected).outcome,
    'partial_list');
  assert.equal(parseStripeTestGroupChargeRisk(invoice,payments(),links(),{
    ...expected,customerId:'cus_foreign',
  }).outcome,'invoice_mismatch');
  const broken=links();
  broken[1]!.charge={...broken[1]!.charge,customer:'cus_foreign'};
  assert.equal(parseStripeTestGroupChargeRisk(invoice,payments(),broken,expected).outcome,
    'invalid_risk_graph');
});
