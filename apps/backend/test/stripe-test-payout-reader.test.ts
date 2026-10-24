import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripeTestPayoutReader } from '../src/billing/stripe-test-payout-reader';

test('ADR-121 payout reader only sends GET to fixed Stripe TEST host', async () => {
  assert.throws(() => new StripeTestPayoutReader('sk_live_invalid'));
  const key = 'sk_test_' + 'a'.repeat(32);
  const urls: string[] = [];
  const reader = new StripeTestPayoutReader(key, async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + key);
    if (String(input).includes('/v1/payouts/')) {
      return new Response(JSON.stringify({ object: 'payout' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        object: 'list',
        has_more: false,
        data: [{ id: 'txn_test1', object: 'balance_transaction' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  await reader.retrievePayout('po_test1');
  await reader.listAutomaticPayoutTransactions('po_test1');
  assert.deepEqual(urls, [
    'https://api.stripe.com/v1/payouts/po_test1',
    'https://api.stripe.com/v1/balance_transactions?payout=po_test1&limit=100',
  ]);
  await assert.rejects(reader.retrievePayout('po_test1?expand[]=destination'));
  await assert.rejects(reader.listAutomaticPayoutTransactions('po_test1&limit=999'));
  assert.equal(urls.length, 2);
});

// prettier-ignore
test('ADR-121 payout pagination refuses incomplete cycles and duplicate cursor IDs', async () => {
  const key = 'sk_test_' + 'b'.repeat(32);
  const urls: string[] = [];
  // prettier-ignore
  const reader = new StripeTestPayoutReader(key, async (input) => {
    const url = String(input);
    urls.push(url);
    const id = 'txn_same';
    return new Response(JSON.stringify({
      object: 'list',
      has_more: true,
      data: [{ id, object: 'balance_transaction' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(
    reader.listAutomaticPayoutTransactions('po_cycle'),
    /Malformed or repeated Stripe TEST ID/,
  );
  assert(urls.length <= 3);
  assert(urls.every((url) => url.startsWith(
    'https://api.stripe.com/v1/balance_transactions?payout=po_cycle&limit=100',
  )));
});

test('ADR-121 payout reader follows only Stripe-issued cursors and completes two pages', async () => {
  const key = 'sk_test_' + 'c'.repeat(32);
  const urls: string[] = [];
  const reader = new StripeTestPayoutReader(key, async (input, init) => {
    const url = String(input);
    urls.push(url);
    assert.equal(init?.method, 'GET');
    const second = url.includes('&starting_after=txn_page_one');
    return new Response(
      JSON.stringify({
        object: 'list',
        has_more: !second,
        data: [{ object: 'balance_transaction', id: second ? 'txn_page_two' : 'txn_page_one' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const result = (await reader.listAutomaticPayoutTransactions('po_two_pages')) as {
    object: string;
    has_more: boolean;
    data: Array<{ id: string }>;
  };
  assert.equal(result.object, 'list');
  assert.equal(result.has_more, false);
  assert.deepEqual(
    result.data.map((transaction) => transaction.id),
    ['txn_page_one', 'txn_page_two'],
  );
  assert.deepEqual(urls, [
    'https://api.stripe.com/v1/balance_transactions?payout=po_two_pages&limit=100',
    'https://api.stripe.com/v1/balance_transactions?payout=po_two_pages&limit=100&starting_after=txn_page_one',
  ]);
});

// prettier-ignore
test('ADR-121 payout pagination does not promote three incomplete pages to a complete list', async () => {
  const key='sk_test_'+'d'.repeat(32);
  const urls:string[]=[];
  let page=0;
  const reader=new StripeTestPayoutReader(key,async(input)=>{
    urls.push(String(input));
    page++;
    return new Response(JSON.stringify({object:'list',has_more:true,
      data:[{object:'balance_transaction',id:'txn_page_'+page}]}),
      {status:200,headers:{'content-type':'application/json'}});
  });
  const result=await reader.listAutomaticPayoutTransactions('po_page_cap') as
    {object:string;has_more:boolean;data:Array<{id:string}>};
  assert.equal(result.object,'list');
  assert.equal(result.has_more,true);
  assert.equal(result.data.length,3);
  assert.deepEqual(urls,[
    'https://api.stripe.com/v1/balance_transactions?payout=po_page_cap&limit=100',
    'https://api.stripe.com/v1/balance_transactions?payout=po_page_cap&limit=100&starting_after=txn_page_1',
    'https://api.stripe.com/v1/balance_transactions?payout=po_page_cap&limit=100&starting_after=txn_page_2',
  ]);
});

// prettier-ignore
test('ADR-121 payout pagination stops at 100 items without inferring completion', async () => {
  const key='sk_test_'+'e'.repeat(32);
  let requests=0;
  const reader=new StripeTestPayoutReader(key,async()=>{
    requests++;
    return new Response(JSON.stringify({object:'list',has_more:true,
      data:Array.from({length:100},(_,i)=>({
        object:'balance_transaction',id:'txn_cap_'+String(i+1),
      }))}),{status:200,headers:{'content-type':'application/json'}});
  });
  const result=await reader.listAutomaticPayoutTransactions('po_item_cap') as
    {object:string;has_more:boolean;data:unknown[]};
  assert.equal(result.object,'list');
  assert.equal(result.has_more,true);
  assert.equal(result.data.length,100);
  assert.equal(requests,1);
});

// prettier-ignore
test('ADR-121 payout reader rejects empty advancing pages and malformed Stripe IDs', async () => {
  const key='sk_test_'+'f'.repeat(32);
  for(const data of [[],[{object:'balance_transaction',id:'bad?cursor=1'}]]) {
    let requests=0;
    const reader=new StripeTestPayoutReader(key,async()=>{
      requests++;
      return new Response(JSON.stringify({object:'list',has_more:true,data}),
        {status:200,headers:{'content-type':'application/json'}});
    });
    await assert.rejects(reader.listAutomaticPayoutTransactions('po_invalid_page'),
      /Non-advancing Stripe TEST cursor|Malformed or repeated Stripe TEST ID/);
    assert.equal(requests,1);
  }
});

// prettier-ignore
test('ADR-121 payout reader rejects oversized provider pages even when marked complete', async () => {
  const key='sk_test_'+'g'.repeat(32);
  let requests=0;
  const reader=new StripeTestPayoutReader(key,async()=>{
    requests++;
    return new Response(JSON.stringify({object:'list',has_more:false,
      data:Array.from({length:101},(_,i)=>({object:'balance_transaction',
        id:'txn_oversize_'+(i+1)}))}),
      {status:200,headers:{'content-type':'application/json'}});
  });
  await assert.rejects(reader.listAutomaticPayoutTransactions('po_oversize'),
    /Malformed Stripe TEST list/);
  assert.equal(requests,1);
});

// prettier-ignore
test('ADR-121: payout reader keeps 100-item cross-page result incomplete', async()=>{
  const key='sk_test_'+'h'.repeat(32);
  let requests=0;
  const reader=new StripeTestPayoutReader(key,async()=>{
    requests++;
    const count=requests===1?60:40;
    const start=requests===1?0:60;
    return new Response(JSON.stringify({object:'list',has_more:true,
      data:Array.from({length:count},(_,i)=>({
        object:'balance_transaction',id:'txn_bounded_'+(start+i+1),
      }))}),{status:200,headers:{'content-type':'application/json'}});
  });
  const result=await reader.listAutomaticPayoutTransactions('po_cross_page') as
    {object:string;has_more:boolean;data:unknown[]};
  assert.equal(result.object,'list');
  assert.equal(result.data.length,100);
  assert.equal(result.has_more,true);
  assert.equal(requests,2);
});
