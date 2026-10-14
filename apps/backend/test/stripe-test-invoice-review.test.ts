import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStripeTestInvoiceReview } from '../src/billing/stripe-test-invoice-review';

const start=1790899200, end=1793577600, paidAt=1790900000;
const expected={
  invoiceId:'in_review',customerId:'cus_review',subscriptionId:'sub_review',
  priceId:'price_review',currency:'EUR',amountPaidMinor:1999n,
  paidAt:new Date(paidAt*1000),
};
const invoice={
  object:'invoice',id:expected.invoiceId,livemode:false,status:'paid',
  paid:true,paid_out_of_band:false,collection_method:'charge_automatically',
  customer:expected.customerId,currency:'eur',amount_paid:1999,
  total:1999,amount_remaining:0,
  parent:{subscription_details:{subscription:expected.subscriptionId}},
  status_transitions:{paid_at:paidAt},
  lines:{object:'list',has_more:false,data:[{
    object:'line_item',livemode:false,
    parent:{type:'subscription_item_details',
      subscription_item_details:{subscription:expected.subscriptionId}},
    pricing:{type:'price_details',
      price_details:{price:expected.priceId}},
    period:{start,end},
  }]},
};
const emptyNotes={object:'list',has_more:false,data:[]};
const note=(status:'issued'|'void',amount:number)=>({
  id:'cn_'+status,object:'credit_note',livemode:false,status,amount,
  invoice:expected.invoiceId,customer:expected.customerId,currency:'eur',
});

// prettier-ignore
test('service period is from the single subscription line, not invoice lookback',()=>{
  const parsed=parseStripeTestInvoiceReview({
    ...invoice,period_start:start-86400,period_end:start,
  },emptyNotes,expected);
  assert.equal(parsed.outcome,'valid');
  if(parsed.outcome!=='valid') throw new Error('review parse failed');
  assert.equal(parsed.snapshot.periodStart.getTime(),start*1000);
  assert.equal(parsed.snapshot.periodEnd.getTime(),end*1000);
  assert.equal(parsed.snapshot.creditNoteCount,0);
  assert.equal(parsed.snapshot.issuedCreditMinor,0n);

  const withNotes=parseStripeTestInvoiceReview(invoice,{
    object:'list',has_more:false,data:[note('issued',500),note('void',300)],
  },expected);
  assert.equal(withNotes.outcome,'valid');
  if(withNotes.outcome!=='valid') throw new Error('missing note snapshot');
  assert.equal(withNotes.snapshot.issuedCreditMinor,500n);
  assert.equal(withNotes.snapshot.creditNoteCount,1);
  assert.notEqual(withNotes.snapshot.digest,parsed.snapshot.digest);
  const reorder=parseStripeTestInvoiceReview(invoice,{
    object:'list',has_more:false,data:[note('void',300),note('issued',500)],
  },expected);
  assert.equal(reorder.outcome,'valid');
  if(reorder.outcome==='valid') assert.equal(reorder.snapshot.digest,withNotes.snapshot.digest);
});

// prettier-ignore
test('credit-note pagination, wrong invoice, price/proration and amounts fail closed',()=>{
  for(const notes of [
    {object:'list',has_more:true,data:[]},
    {object:'list',has_more:false,data:[{...note('issued',500),invoice:'in_foreign'}]},
    {object:'list',has_more:false,data:[{...note('issued',500),customer:'cus_foreign'}]},
    {object:'list',has_more:false,data:[note('issued',500),note('issued',500)]},
    {object:'list',has_more:false,data:[{...note('issued',500),currency:'usd'}]},
    {object:'list',has_more:false,data:[note('issued',2000)]},
    {object:'list',has_more:false,data:[{...note('issued',500),livemode:true}]},
  ]) assert.notEqual(parseStripeTestInvoiceReview(invoice,notes,expected).outcome,'valid');
  const periodLine=invoice.lines.data[0];
  for(const line of [
    {...periodLine,period:{start,end:start}},
    {...periodLine,pricing:{type:'price_details',price_details:{price:'price_wrong'}}},
    {...periodLine,parent:{type:'invoice_item_details'}},
  ]) assert.equal(parseStripeTestInvoiceReview({
    ...invoice,lines:{object:'list',has_more:false,data:[line]},
  },emptyNotes,expected).outcome,'invalid_period');
  assert.equal(parseStripeTestInvoiceReview({
    ...invoice,lines:{object:'list',has_more:true,data:[periodLine]},
  },emptyNotes,expected).outcome,'invalid_period');
});
