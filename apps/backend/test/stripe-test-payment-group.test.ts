import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStripeTestPaymentGroup,PaymentGroupLink } from '../src/billing/stripe-test-payment-group';

const paidAt=1780000000;
const expected={
  invoiceId:'in_multi',customerId:'cus_multi',subscriptionId:'sub_multi',
  currency:'EUR',amountPaidMinor:1999n,paidAt:new Date(paidAt*1000),
};
const invoice={
  object:'invoice',id:expected.invoiceId,livemode:false,status:'paid',
  paid:true,paid_out_of_band:false,collection_method:'charge_automatically',
  customer:expected.customerId,currency:'eur',amount_paid:1999,
  total:1999,amount_remaining:0,
  parent:{subscription_details:{subscription:expected.subscriptionId}},
  status_transitions:{paid_at:paidAt},
};
const row=(n:number,amount:number)=>({
  id:'inpay_multi'+n,object:'invoice_payment',livemode:false,
  status:'paid',invoice:expected.invoiceId,currency:'eur',
  amount_paid:amount,payment:{type:'payment_intent',payment_intent:'pi_multi'+n},
});
const link=(n:number,amount:number):PaymentGroupLink=>({
  paymentIntent:{
    id:'pi_multi'+n,object:'payment_intent',livemode:false,
    status:'succeeded',customer:expected.customerId,
    currency:'eur',amount_received:amount,latest_charge:'ch_multi'+n,
  },
  charge:{
    id:'ch_multi'+n,object:'charge',livemode:false,
    status:'succeeded',customer:expected.customerId,
    currency:'eur',paid:true,captured:true,
    payment_intent:'pi_multi'+n,amount,
  },
});
const payments=(data:unknown[],has_more=false)=>({
  object:'list',data,has_more,
});
const validPayments=payments([row(1,1000),row(2,999)]);
const links=[link(1,1000),link(2,999)];

// prettier-ignore
test('multiple linked Stripe TEST InvoicePayments are only observations',()=>{
  const observed=parseStripeTestPaymentGroup(invoice,validPayments,links,expected);
  assert.equal(observed.outcome,'valid');
  if(observed.outcome!=='valid')throw new Error('missing snapshot');
  assert.equal(observed.snapshot.count,2);
  assert.equal(observed.snapshot.paidMinor,1999n);
  const again=parseStripeTestPaymentGroup(
    invoice,payments([row(2,999),row(1,1000)]),
    [links[1],links[0]],expected,
  );
  assert.equal(again.outcome,'valid');
  if(again.outcome==='valid')
    assert.equal(again.snapshot.digest,observed.snapshot.digest);
  const changed=parseStripeTestPaymentGroup(
    invoice,payments([row(1,1200),row(2,799)]),
    [link(1,1200),link(2,799)],expected,
  );
  assert.equal(changed.outcome,'valid');
  if(changed.outcome==='valid')
    assert.notEqual(changed.snapshot.digest,observed.snapshot.digest);
});

// prettier-ignore
test('multi-payment parser rejects incomplete, mixed-customer and fabricated allocation',()=>{
  assert.equal(parseStripeTestPaymentGroup(invoice,payments([row(1,1000)],true),
    [links[0]],expected).outcome,'partial_list');
  assert.equal(parseStripeTestPaymentGroup(invoice,payments([row(1,1999)]),
    [link(1,1999)],expected).outcome,'unsupported_payment_count');
  assert.equal(parseStripeTestPaymentGroup({...invoice,livemode:true},
    validPayments,links,expected).outcome,'invoice_mismatch');
  const invalid:Array<[unknown,PaymentGroupLink[]]>= [
    [payments([row(1,1000),row(1,999)]),links],
    [payments([row(1,1000),{...row(2,999),invoice:'in_foreign'}]),links],
    [payments([row(1,1000),row(2,998)]),links],
    [validPayments,[{...links[0],paymentIntent:{
      ...(links[0].paymentIntent as object),customer:'cus_foreign',
    }},links[1]]],
    [validPayments,[links[0],{...links[1],charge:{
      ...(links[1].charge as object),paid:false,
    }}]],
    [validPayments,[links[0],{...links[1],charge:{
      ...(links[1].charge as object),amount:1000,
    }}]],
  ];
  for(const [list,bundles] of invalid)
    assert.equal(parseStripeTestPaymentGroup(invoice,list,bundles,expected).outcome,
      'invalid_payment_graph');
});
