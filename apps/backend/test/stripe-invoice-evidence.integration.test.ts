import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { recordStoredStripeTestInvoice } from '../src/billing/stripe-invoice-evidence-verifier';

const uuidPart = () => randomUUID().replace(/-/g, '');
const eventId = () => 'evt_' + uuidPart();
const invoiceId = () => 'in_' + uuidPart();

// PostgreSQL real: RLS, verifier grants, signed inbox references,
// provider mocked (NOT a Stripe sandbox E2E or payment settlement test).
// prettier-ignore
test('restricted Stripe test invoice evidence is linked, replay-safe and non-entitling', {timeout:60000},async()=>{
  const migration=process.env.MIGRATION_DATABASE_URL;
  const verifierUrl=process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const runtimeUrl=process.env.DATABASE_URL;
  assert(migration&&verifierUrl&&runtimeUrl);
  const admin=new PrismaClient({datasources:{db:{url:migration}}});
  const verifier=new PrismaClient({datasources:{db:{url:verifierUrl}}});
  const runtime=new PrismaClient({datasources:{db:{url:runtimeUrl}}});
  const tenantA=randomUUID(),tenantB=randomUUID(),planId=randomUUID();
  const priceId='price_'+uuidPart(),customerId='cus_'+uuidPart();
  const subscriptionId='sub_'+uuidPart(),subscriptionRowId=randomUUID();
  const checkoutId='cs_test_'+uuidPart();
  const paidAt=Math.floor(Date.now()/1000)-90;
  const start=paidAt-120,end=paidAt+86400*30;
  let activeInvoiceId=invoiceId();
  let invoiceOverride: Record<string,unknown>={};
  let subscriptionOverride: Record<string,unknown>={};
  let providerUnavailable=false;
  const invoice=()=>({
    object:'invoice',id:activeInvoiceId,livemode:false,
    customer:customerId,
    parent:{subscription_details:{subscription:subscriptionId}},
    collection_method:'charge_automatically',paid:true,
    paid_out_of_band:false,status:'paid',currency:'eur',
    amount_paid:1999,total:1999,amount_remaining:0,
    status_transitions:{paid_at:paidAt},...invoiceOverride,
  });
  const subscription=()=>({
    object:'subscription',id:subscriptionId,customer:customerId,
    livemode:false,status:'active',trial_end:null,cancel_at_period_end:false,
    items:{data:[{price:{id:priceId},current_period_start:start,
      current_period_end:end}],has_more:false},...subscriptionOverride,
  });
  let invoiceCalls=0,subscriptionCalls=0;
  const provider={
    retrieveInvoice:async(id:string)=>{
      invoiceCalls++;
      assert.equal(id,activeInvoiceId);
      if(providerUnavailable) throw new Error('sensitive provider error');
      return invoice();
    },
    retrieveSubscription:async(id:string)=>{
      subscriptionCalls++;
      assert.equal(id,subscriptionId);
      return subscription();
    },
  };
  const signed=async(id:string,type='invoice.paid',metadata?:object)=>{
    const eid=eventId();
    await admin.stripeWebhookEvent.create({data:{
      eventId:eid,eventType:type,providerCreatedAt:new Date(),
      payloadSha256:'e'.repeat(64),livemode:false,
      payload:{id:eid,object:'event',type,livemode:false,
        data:{object:{id,object:'invoice',
          metadata:metadata??{tenant_id:tenantB}}}} as Prisma.InputJsonValue,
    }});
    return eid;
  };
  try {
    await admin.tenant.create({
      data:{id:tenantA,name:'Invoice bound',countryCode:'PT',
        timezone:'Europe/Lisbon'},
    });
    await admin.tenant.create({
      data:{id:tenantB,name:'Invoice other',countryCode:'PT',
        timezone:'Europe/Lisbon'},
    });
    await admin.billingPlan.create({data:{
      id:planId,key:'invoice-'+uuidPart(),name:'Invoice test',
      currency:'EUR',basePrice:'19.990000',billingInterval:'month',
      includedConversations:10,includedStaff:1,includedChannels:1,
      includedLocations:1,overagePricePerConversation:'0',features:{},
      active:true,stripePriceId:priceId,stripeProductId:'prod_'+uuidPart(),
    }});
    await admin.stripeCheckoutIntent.create({data:{
      id:randomUUID(),tenantId:tenantA,planId,requestId:randomUUID(),
      stripePriceId:priceId,checkoutSessionId:checkoutId,status:'ready',
      checkoutUrl:'https://checkout.stripe.com/c/pay/'+checkoutId,
      expiresAt:new Date(Date.now()+3600000),
    }});
    await admin.tenantSubscription.create({data:{
      tenantId:tenantA,id:subscriptionRowId,planId,provider:'stripe',
      providerCustomerId:customerId,providerSubscriptionId:subscriptionId,
      checkoutSessionId:checkoutId,status:'active',
      currentPeriodStart:new Date(start*1000),
      currentPeriodEnd:new Date(end*1000),
    }});
    const original=await signed(activeInvoiceId);
    await assert.rejects(
      recordStoredStripeTestInvoice(admin,original,provider),
      /Dedicated invoice verifier role required/,
    );
    assert.equal(invoiceCalls,0);
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,original,provider),
      {outcome:'recorded',reason:'provider_verified'});
    const evidence=await admin.stripeTestInvoiceEvidence.findUniqueOrThrow({
      where:{invoiceId:activeInvoiceId},
    });
    assert.equal(evidence.tenantId,tenantA);
    assert.equal(evidence.subscriptionId,subscriptionRowId);
    assert.equal(evidence.sourceEventId,original);
    assert.equal(evidence.amountPaidMinor,1999n);
    assert.equal(evidence.billable,false);
    assert.equal(evidence.entitlementVerified,false);
    assert.equal(evidence.currency,'EUR');
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,original,provider),
      {outcome:'replayed',reason:'already_recorded'});
    assert.equal(await admin.stripeTestInvoiceEvidence.count(),1);
    assert.equal(await admin.stripeInvoiceEvidenceAttempt.count({where:{eventId:original}}),2);
    assert.equal(await admin.stripeTestInvoiceEvidence.count({where:{tenantId:tenantB}}),0);

    // Signed metadata claims tenant B; fresh provider IDs still bind only A.
    activeInvoiceId=invoiceId();
    const maliciousMetadata=await signed(activeInvoiceId,'invoice.paid',{
      tenant_id:tenantB,subscription_id:'sub_'+uuidPart(),
    });
    assert.deepEqual(
      await recordStoredStripeTestInvoice(verifier,maliciousMetadata,provider),
      {outcome:'recorded',reason:'provider_verified'});
    assert.equal(await admin.stripeTestInvoiceEvidence.count({where:{tenantId:tenantA}}),2);
    assert.equal(await admin.stripeTestInvoiceEvidence.count({where:{tenantId:tenantB}}),0);

    activeInvoiceId=invoiceId();
    const unpaidEvent=await signed(activeInvoiceId);
    invoiceOverride={status:'open',paid:false};
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,unpaidEvent,provider),
      {outcome:'rejected',reason:'invalid_provider_snapshot'});
    invoiceOverride={paid_out_of_band:true};
    assert.equal((await recordStoredStripeTestInvoice(verifier,unpaidEvent,provider)).outcome,
      'rejected');
    invoiceOverride={};
    subscriptionOverride={customer:'cus_'+uuidPart()};
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,unpaidEvent,provider),
      {outcome:'rejected',reason:'subscription_mismatch'});
    subscriptionOverride={items:{data:[{price:{id:'price_'+uuidPart()},
      current_period_start:start,current_period_end:end}],has_more:false}};
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,unpaidEvent,provider),
      {outcome:'rejected',reason:'invoice_mismatch'});
    subscriptionOverride={};
    invoiceOverride={currency:'usd'};
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,unpaidEvent,provider),
      {outcome:'rejected',reason:'invoice_mismatch'});
    invoiceOverride={};
    providerUnavailable=true;
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,unpaidEvent,provider),
      {outcome:'deferred',reason:'provider_unavailable'});
    providerUnavailable=false;
    const badSource=await signed(activeInvoiceId,'invoice.payment_failed');
    const before=invoiceCalls;
    assert.deepEqual(await recordStoredStripeTestInvoice(verifier,badSource,provider),
      {outcome:'rejected',reason:'unsupported_event'});
    assert.equal(invoiceCalls,before);

    await assert.rejects(admin.stripeTestInvoiceEvidence.update({
      where:{invoiceId:evidence.invoiceId},data:{amountPaidMinor:999n},
    }));
    await assert.rejects(admin.stripeTestInvoiceEvidence.delete({
      where:{invoiceId:evidence.invoiceId},
    }));
    await assert.rejects(verifier.stripeTestInvoiceEvidence.delete({
      where:{invoiceId:evidence.invoiceId},
    }));

    const [rights]=await admin.$queryRaw<Array<{
      verifierInserts:boolean;verifierUpdates:boolean;verifierDeletes:boolean;
      runtimeReadsMoney:boolean;runtimeReadsBillable:boolean;
      runtimeInserts:boolean;reconcilerInserts:boolean;
    }>>`SELECT
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_evidence','INSERT') AS "verifierInserts",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_evidence','UPDATE') AS "verifierUpdates",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_evidence','DELETE') AS "verifierDeletes",
      has_column_privilege('melissa_runtime','stripe_test_invoice_evidence',
        'amount_paid_minor','SELECT') AS "runtimeReadsMoney",
      has_column_privilege('melissa_runtime','stripe_test_invoice_evidence',
        'billable','SELECT') AS "runtimeReadsBillable",
      has_table_privilege('melissa_runtime',
        'stripe_test_invoice_evidence','INSERT') AS "runtimeInserts",
      has_table_privilege('melissa_billing_reconciler',
        'stripe_test_invoice_evidence','INSERT') AS "reconcilerInserts"`;
    // Column-scoped INSERT does not confer table-wide INSERT.
    assert.deepEqual(rights,{
      verifierInserts:false,verifierUpdates:false,verifierDeletes:false,
      runtimeReadsMoney:false,runtimeReadsBillable:true,
      runtimeInserts:false,reconcilerInserts:false,
    });
    const [rls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_test_invoice_evidence'`;
    assert.deepEqual(rls,{relrowsecurity:true,relforcerowsecurity:true});
    const [unscoped]=await runtime.$queryRaw<Array<{n:bigint}>>`
      SELECT COUNT(tenant_id)::bigint AS n FROM stripe_test_invoice_evidence`;
    assert.equal(unscoped?.n,0n);
    const scoped=await runtime.$transaction(async(tx)=>{
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA},true)`;
      const [count]=await tx.$queryRaw<Array<{n:bigint}>>`
        SELECT COUNT(tenant_id)::bigint AS n FROM stripe_test_invoice_evidence`;
      return count?.n;
    });
    assert.equal(scoped,2n);
    await assert.rejects(runtime.stripeTestInvoiceEvidence.findFirst());
  } finally {
    await Promise.all([admin.$disconnect(),verifier.$disconnect(),runtime.$disconnect()]);
  }
});
