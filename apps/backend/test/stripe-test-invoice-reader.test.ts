import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  StripeTestInvoiceReader,
  stripeTestPaidInvoiceSnapshot,
} from '../src/billing/stripe-test-invoice-reader';

const paidAt = 1780000000;
const invoice = {
  object: 'invoice',
  id: 'in_fixture123',
  livemode: false,
  customer: 'cus_fixture123',
  parent: { subscription_details: { subscription: 'sub_fixture123' } },
  collection_method: 'charge_automatically',
  paid: true,
  paid_out_of_band: false,
  status: 'paid',
  currency: 'eur',
  amount_paid: 1999,
  total: 1999,
  amount_remaining: 0,
  status_transitions: { paid_at: paidAt },
};

// prettier-ignore
test('Stripe invoice parser rejects unverified, credit-only and cross-mode state', () => {
  const parsed = stripeTestPaidInvoiceSnapshot(invoice);
  assert(parsed);
  assert.equal(parsed.amountPaidMinor,1999n);
  assert.equal(parsed.currency,'EUR');
  assert.equal(parsed.subscription,'sub_fixture123');
  for (const mutation of [
    { livemode:true }, { status:'open' }, { paid:false },
    { paid_out_of_band:true }, { collection_method:'send_invoice' },
    { amount_paid:0,total:0 }, { amount_paid:-1 },
    { total:1998 }, { amount_remaining:1 },
    { parent:null }, { currency:'EUR' }, { customer:'not-customer' },
    { status_transitions:{paid_at:null} }, { id:'in_live/evil' },
    { object:'checkout.session' },
  ]) assert.equal(stripeTestPaidInvoiceSnapshot({...invoice,...mutation}),null);
});

// prettier-ignore
test('invoice provider restricts credentials, endpoint, response and redirects', async () => {
  assert.throws(() => new StripeTestInvoiceReader('sk_live_invalid'));
  const key='sk_test_'+'a'.repeat(32);
  const urls:string[]=[];
  const reader=new StripeTestInvoiceReader(key,async(input,init)=>{
    const url=String(input);
    urls.push(url);
    assert.equal(init?.method,'GET');
    assert.equal(init?.redirect,'error');
    const headers=init?.headers as Record<string,string>;
    assert.equal(headers.Authorization,'Bearer '+key);
    assert.equal(headers['Stripe-Version'],'2025-09-30.clover');
    return new Response(JSON.stringify(invoice),{
      status:200,headers:{'content-type':'application/json'},
    });
  });
  assert.deepEqual(await reader.retrieveInvoice(invoice.id),invoice);
  assert.deepEqual(await reader.retrieveSubscription('sub_fixture123'),invoice);
  assert.deepEqual(urls,[
    'https://api.stripe.com/v1/invoices/in_fixture123',
    'https://api.stripe.com/v1/subscriptions/sub_fixture123',
  ]);
  await assert.rejects(reader.retrieveInvoice('https://evil.example'));
  await assert.rejects(reader.retrieveSubscription('sub_live/exploit'));
  assert.equal(urls.length,2);
  const unavailable=new StripeTestInvoiceReader(key,async()=>{
    return new Response('not available',{status:503});
  });
  await assert.rejects(unavailable.retrieveInvoice(invoice.id));
});
