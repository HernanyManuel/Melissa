import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readBoundedStripeList, MAX_STRIPE_LIST_ITEMS, MAX_STRIPE_LIST_PAGES,
} from '../src/billing/stripe-test-cursor-pagination';
import { StripeTestPaymentRiskReader } from '../src/billing/stripe-test-payment-risk';
import { StripeTestInvoiceReviewReader } from '../src/billing/stripe-test-invoice-review';

const list=(data:unknown[],has_more=false)=>({object:'list',data,has_more});
const row=(id:string)=>({id,object:'refund'});

// prettier-ignore
test('bounded cursor pagination returns exactly complete data and rejects cycles',async()=>{
  const cursors:(string|null)[]=[];
  const complete=await readBoundedStripeList(async(cursor)=>{
    cursors.push(cursor);
    return cursor===null?list([row('re_aa'),row('re_bb')],true)
      :list([row('re_cc')]);
  });
  assert.deepEqual(cursors,[null,'re_bb']);
  assert.deepEqual(complete,list([row('re_aa'),row('re_bb'),row('re_cc')]));
  await assert.rejects(readBoundedStripeList(async()=>list([],true)),
    /Non-advancing/);
  await assert.rejects(readBoundedStripeList(async()=>list([
    row('re_dup'),row('re_dup'),
  ])),/repeated/);
  await assert.rejects(readBoundedStripeList(async(cursor)=>
    cursor===null?list([row('re_cycle')],true)
      :list([row('re_cycle')],true)),/repeated/);
  await assert.rejects(readBoundedStripeList(async()=>
    ({object:'list',data:[row('re_a')],has_more:'yes'})),
  /Malformed/);
  await assert.rejects(readBoundedStripeList(async()=>list([
    {id:'bad?cursor=evil'},
  ],true)),/Malformed/);
  assert.equal(MAX_STRIPE_LIST_ITEMS,100);
  assert.equal(MAX_STRIPE_LIST_PAGES,3);
  const first=Array.from({length:60},(_,i)=>row('re_A'+i));
  const second=Array.from({length:60},(_,i)=>row('re_B'+i));
  const truncated=await readBoundedStripeList(async(cursor)=>
    cursor===null?list(first,true):list(second,false));
  assert.equal(truncated.has_more,true);
  assert.equal(truncated.data.length,100);
  let pages=0;
  const exhausted=await readBoundedStripeList(async()=>{
    pages++;
    return list([row('re_page'+pages)],true);
  });
  assert.equal(pages,MAX_STRIPE_LIST_PAGES);
  assert.equal(exhausted.has_more,true);
});

// prettier-ignore
test('TEST adapters follow fixed Stripe endpoints and starting_after only',async()=>{
  const calls:string[]=[];
  const key='sk_test_'+'a'.repeat(32);
  const mocked=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);calls.push(url);
    assert.equal(init?.method,'GET');
    assert.equal(init?.redirect,'error');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+key);
    const data= url.includes('starting_after=')
      ? list([{id:'re_page2',object:'refund'}],false)
      : list([{id:'re_page1',object:'refund'}],true);
    return new Response(JSON.stringify(data),{
      status:200,headers:{'content-type':'application/json'},
    });
  };
  const risk=new StripeTestPaymentRiskReader(key,mocked);
  const credit=new StripeTestInvoiceReviewReader(key,mocked);
  const refunds=await risk.listRefunds('ch_safe');
  const payments=await risk.listInvoicePayments('in_safe');
  const disputes=await risk.listDisputes('ch_safe');
  const notes=await credit.listCreditNotes('in_safe');
  for(const result of [refunds,payments,disputes,notes]){
    assert.deepEqual(result,list([
      {id:'re_page1',object:'refund'},{id:'re_page2',object:'refund'},
    ]));
  }
  assert.deepEqual(calls,[
    'https://api.stripe.com/v1/refunds?charge=ch_safe&limit=100',
    'https://api.stripe.com/v1/refunds?charge=ch_safe&limit=100&starting_after=re_page1',
    'https://api.stripe.com/v1/invoice_payments?invoice=in_safe&limit=100',
    'https://api.stripe.com/v1/invoice_payments?invoice=in_safe&limit=100&starting_after=re_page1',
    'https://api.stripe.com/v1/disputes?charge=ch_safe&limit=100',
    'https://api.stripe.com/v1/disputes?charge=ch_safe&limit=100&starting_after=re_page1',
    'https://api.stripe.com/v1/credit_notes?invoice=in_safe&limit=100',
    'https://api.stripe.com/v1/credit_notes?invoice=in_safe&limit=100&starting_after=re_page1',
  ]);
  await assert.rejects(risk.listRefunds('ch_a?invoice=in_other'));
});
