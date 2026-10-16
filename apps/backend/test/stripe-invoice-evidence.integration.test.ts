import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, PrismaClient } from '@prisma/client';
import { recordStoredStripeTestInvoice } from '../src/billing/stripe-invoice-evidence-verifier';
import { reviewStoredStripeTestInvoice } from '../src/billing/stripe-invoice-review-verifier';
import { reviewStripeTestPaymentRisk } from '../src/billing/stripe-payment-risk-verifier';
import { reviewStripeTestPaymentGroup } from '../src/billing/stripe-payment-group-verifier';
import { reviewStripeTestGroupChargeRisk } from '../src/billing/stripe-group-charge-risk-verifier';
import { reviewStripeTestGroupBalances } from '../src/billing/stripe-group-balance-verifier';

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
  let invoiceCalls=0;
  const provider={
    retrieveInvoice:async(id:string)=>{
      invoiceCalls++;
      assert.equal(id,activeInvoiceId);
      if(providerUnavailable) throw new Error('sensitive provider error');
      return invoice();
    },
    retrieveSubscription:async(id:string)=>{
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

    // ADR-116: periods come from an authenticated invoice LINE, never the
    // invoice's lookback period. Credit notes can change later; each new
    // observation is a different immutable digest, NEVER clearance.
    const notes:Array<Record<string,unknown>>=[];
    let hasMore=false;
    const reviewProvider={
      retrieveInvoice:async(id:string)=>{
        assert.equal(id,evidence.invoiceId);
        return {...invoice(),period_start:start-86400,period_end:start,
          lines:{object:'list',has_more:false,data:[{
            object:'line_item',livemode:false,
            parent:{type:'subscription_item_details',
              subscription_item_details:{subscription:subscriptionId}},
            pricing:{type:'price_details',price_details:{price:priceId}},
            period:{start,end},
          }]}};
      },
      retrieveSubscription:provider.retrieveSubscription,
      listCreditNotes:async(id:string)=>{
        assert.equal(id,evidence.invoiceId);
        return {object:'list',has_more:hasMore,data:notes};
      },
    };
    await assert.rejects(reviewStoredStripeTestInvoice(admin,evidence.invoiceId,reviewProvider),
      /Dedicated invoice verifier role required/);
    assert.deepEqual(
      await reviewStoredStripeTestInvoice(verifier,evidence.invoiceId,reviewProvider),
      {outcome:'recorded',reason:'snapshot_observed'});
    let review=await admin.stripeTestInvoiceReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId},
    });
    assert.equal(review.tenantId,tenantA);
    assert.equal(review.subscriptionId,subscriptionRowId);
    assert.equal(review.servicePeriodStart.getTime(),start*1000);
    assert.equal(review.servicePeriodEnd.getTime(),end*1000);
    assert.equal(review.issuedCreditMinor,0n);
    assert.equal(review.refundsVerified,false);
    assert.equal(review.financialClearance,false);
    assert.equal(review.billable,false);
    assert.deepEqual(
      await reviewStoredStripeTestInvoice(verifier,evidence.invoiceId,reviewProvider),
      {outcome:'replayed',reason:'already_observed'});
    assert.equal(await admin.stripeTestInvoiceReview.count(),1);
    const note={
      id:'cn_'+uuidPart(),object:'credit_note',status:'issued',
      livemode:false,invoice:evidence.invoiceId,customer:customerId,
      currency:'eur',amount:400,
    };
    notes.push(note);
    assert.deepEqual(await reviewStoredStripeTestInvoice(
      verifier,evidence.invoiceId,reviewProvider),
      {outcome:'recorded',reason:'snapshot_observed'});
    review=await admin.stripeTestInvoiceReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId,creditNoteCount:1},
    });
    assert.equal(review.issuedCreditMinor,400n);
    assert.equal(await admin.stripeTestInvoiceReview.count(),2);
    hasMore=true;
    assert.deepEqual(await reviewStoredStripeTestInvoice(
      verifier,evidence.invoiceId,reviewProvider),
      {outcome:'deferred',reason:'incomplete_credits'});
    hasMore=false;
    notes[0]={...note,customer:'cus_foreign'};
    assert.deepEqual(await reviewStoredStripeTestInvoice(
      verifier,evidence.invoiceId,reviewProvider),
      {outcome:'rejected',reason:'invalid_credit_notes'});
    notes[0]=note;
    assert.equal(await admin.stripeTestInvoiceReview.count(),2);
    assert.equal(await admin.stripeInvoiceReviewAttempt.count({
      where:{invoiceId:evidence.invoiceId},
    }),5);
    await assert.rejects(admin.stripeTestInvoiceReview.update({
      where:{id:review.id},data:{issuedCreditMinor:1n},
    }));
    await assert.rejects(admin.stripeTestInvoiceReview.delete({
      where:{id:review.id},
    }));
    await assert.rejects(verifier.stripeTestInvoiceReview.delete({
      where:{id:review.id},
    }));
    const [reviewGrants]=await admin.$queryRaw<Array<{
      runtimeRead:boolean;runtimeWrite:boolean;verifierUpdate:boolean;
      verifierDelete:boolean;otherVerifierWrite:boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime','stripe_test_invoice_reviews','SELECT')
        AS "runtimeRead",
      has_table_privilege('melissa_runtime','stripe_test_invoice_reviews','INSERT')
        AS "runtimeWrite",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_reviews','UPDATE') AS "verifierUpdate",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_reviews','DELETE') AS "verifierDelete",
      has_table_privilege('melissa_billing_reconciler',
        'stripe_test_invoice_reviews','INSERT') AS "otherVerifierWrite"`;
    assert.deepEqual(reviewGrants,{
      runtimeRead:false,runtimeWrite:false,
      verifierUpdate:false,verifierDelete:false,otherVerifierWrite:false,
    });
    const [reviewRls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_test_invoice_reviews'`;
    assert.deepEqual(reviewRls,{relrowsecurity:true,relforcerowsecurity:true});
    await assert.rejects(runtime.stripeTestInvoiceReview.count());

    // ADR-117: a charge is discovered through fresh TEST invoice payments,
    // not metadata or any operator-supplied cross-tenant charge ID.
    const piId='pi_'+uuidPart(),chargeId='ch_'+uuidPart();
    const refundId='re_'+uuidPart(),disputeId='du_'+uuidPart();
    const refunds:Array<Record<string,unknown>>=[];
    const disputes:Array<Record<string,unknown>>=[];
    let riskHasMore=false;
    let forgedCustomer=false;
    const riskProvider={
      retrieveInvoice:reviewProvider.retrieveInvoice,
      retrieveSubscription:provider.retrieveSubscription,
      listInvoicePayments:async(id:string)=>{
        assert.equal(id,evidence.invoiceId);
        return {object:'list',has_more:false,data:[{
          object:'invoice_payment',invoice:evidence.invoiceId,
          livemode:false,status:'paid',currency:'eur',
          amount_paid:1999,
          payment:{type:'payment_intent',payment_intent:piId},
        }]};
      },
      retrievePaymentIntent:async(id:string)=>{
        assert.equal(id,piId);
        return {id:piId,object:'payment_intent',livemode:false,
          status:'succeeded',customer:customerId,currency:'eur',
          amount_received:1999,latest_charge:chargeId};
      },
      retrieveCharge:async(id:string)=>{
        assert.equal(id,chargeId);
        return {object:'charge',id:chargeId,livemode:false,
          status:'succeeded',paid:true,captured:true,
          customer:forgedCustomer?'cus_foreign':customerId,
          currency:'eur',payment_intent:piId,amount:1999};
      },
      listRefunds:async(id:string)=>{
        assert.equal(id,chargeId);
        return {object:'list',has_more:riskHasMore,data:refunds};
      },
      listDisputes:async(id:string)=>{
        assert.equal(id,chargeId);
        return {object:'list',has_more:false,data:disputes};
      },
    };
    await assert.rejects(
      reviewStripeTestPaymentRisk(admin,evidence.invoiceId,riskProvider),
      /Dedicated invoice verifier role required/,
    );
    assert.deepEqual(await reviewStripeTestPaymentRisk(
      verifier,evidence.invoiceId,riskProvider),
      {outcome:'recorded',reason:'snapshot_observed'});
    let risk=await admin.stripeTestPaymentRiskReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId},
    });
    assert.equal(risk.tenantId,tenantA);
    assert.equal(risk.subscriptionId,subscriptionRowId);
    assert.equal(risk.refundCount,0);
    assert.equal(risk.disputeCount,0);
    assert.equal(risk.settlementVerified,false);
    assert.equal(risk.refundsFinal,false);
    assert.equal(risk.financialClearance,false);
    assert.equal(risk.billable,false);
    assert.deepEqual(await reviewStripeTestPaymentRisk(
      verifier,evidence.invoiceId,riskProvider),
      {outcome:'replayed',reason:'already_observed'});
    refunds.push({object:'refund',id:refundId,livemode:false,
      charge:chargeId,payment_intent:piId,amount:300,
      currency:'eur',status:'pending'});
    assert.equal((await reviewStripeTestPaymentRisk(
      verifier,evidence.invoiceId,riskProvider)).outcome,'recorded');
    refunds[0]={...refunds[0],status:'succeeded'};
    disputes.push({object:'dispute',id:disputeId,livemode:false,
      charge:chargeId,payment_intent:piId,amount:500,
      currency:'eur',status:'needs_response'});
    assert.equal((await reviewStripeTestPaymentRisk(
      verifier,evidence.invoiceId,riskProvider)).outcome,'recorded');
    risk=await admin.stripeTestPaymentRiskReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId,disputeCount:1},
    });
    assert.equal(risk.succeededRefundMinor,300n);
    assert.equal(risk.unresolvedDisputeCount,1);
    assert.equal(await admin.stripeTestPaymentRiskReview.count({
      where:{invoiceId:evidence.invoiceId},
    }),3);
    riskHasMore=true;
    assert.deepEqual(await reviewStripeTestPaymentRisk(
      verifier,evidence.invoiceId,riskProvider),
      {outcome:'deferred',reason:'incomplete_risk_data'});
    riskHasMore=false;
    forgedCustomer=true;
    assert.deepEqual(await reviewStripeTestPaymentRisk(
      verifier,evidence.invoiceId,riskProvider),
      {outcome:'rejected',reason:'charge_mismatch'});
    forgedCustomer=false;
    assert.equal(await admin.stripePaymentRiskAttempt.count({
      where:{invoiceId:evidence.invoiceId},
    }),6);
    await assert.rejects(admin.stripeTestPaymentRiskReview.update({
      where:{id:risk.id},data:{succeededRefundMinor:1n},
    }));
    await assert.rejects(admin.stripeTestPaymentRiskReview.delete({
      where:{id:risk.id},
    }));
    await assert.rejects(verifier.stripeTestPaymentRiskReview.delete({
      where:{id:risk.id},
    }));
    const [riskGrants]=await admin.$queryRaw<Array<{
      runtimeRead:boolean;runtimeWrite:boolean;verifierRead:boolean;
      verifierWrite:boolean;verifierUpdate:boolean;dispatcherWrite:boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime','stripe_test_payment_risk_reviews',
        'SELECT') AS "runtimeRead",
      has_table_privilege('melissa_runtime','stripe_test_payment_risk_reviews',
        'INSERT') AS "runtimeWrite",
      has_column_privilege('melissa_billing_invoice_verifier',
        'stripe_test_payment_risk_reviews','snapshot_sha256','SELECT')
        AS "verifierRead",
      has_column_privilege('melissa_billing_invoice_verifier',
        'stripe_test_payment_risk_reviews','snapshot_sha256','INSERT')
        AS "verifierWrite",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_payment_risk_reviews','UPDATE') AS "verifierUpdate",
      has_table_privilege('melissa_billing_dispatcher',
        'stripe_test_payment_risk_reviews','INSERT') AS "dispatcherWrite"`;
    assert.deepEqual(riskGrants,{
      runtimeRead:false,runtimeWrite:false,verifierRead:true,
      verifierWrite:true,verifierUpdate:false,dispatcherWrite:false,
    });
    const [riskRls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_test_payment_risk_reviews'`;
    assert.deepEqual(riskRls,{relrowsecurity:true,relforcerowsecurity:true});
    await assert.rejects(runtime.stripeTestPaymentRiskReview.count());
    assert.equal(await admin.stripeTestPaymentRiskReview.count({
      where:{tenantId:tenantB},
    }),0);

    // ADR-118: 2 TEST invoice payments linked through independent, fully
    // allocated PaymentIntents and Charges. Never treats them as refunds
    // reconciled, settled, billable or a commercial entitlement.
    const allocation=[{part:1,minor:1000},{part:2,minor:999}];
    let groupIncomplete=false;
    let tamperedGroup=false;
    const groupProvider={
      retrieveInvoice:reviewProvider.retrieveInvoice,
      retrieveSubscription:provider.retrieveSubscription,
      listInvoicePayments:async(id:string)=>{
        assert.equal(id,evidence.invoiceId);
        return {object:'list',has_more:groupIncomplete,
          data:allocation.map(p=>({
            id:'inpay_group_'+p.part,object:'invoice_payment',
            invoice:evidence.invoiceId,livemode:false,status:'paid',
            currency:'eur',amount_paid:p.minor,
            payment:{type:'payment_intent',payment_intent:'pi_group_'+p.part},
          }))};
      },
      retrievePaymentIntent:async(id:string)=>{
        const p=allocation.find(x=>id==='pi_group_'+x.part);
        assert(p);
        return {id,object:'payment_intent',livemode:false,
          status:'succeeded',customer:tamperedGroup?'cus_foreign':customerId,
          currency:'eur',amount_received:p.minor,
          latest_charge:'ch_group_'+p.part};
      },
      retrieveCharge:async(id:string)=>{
        const p=allocation.find(x=>id==='ch_group_'+x.part);
        assert(p);
        return {id,object:'charge',livemode:false,status:'succeeded',
          payment_intent:'pi_group_'+p.part,customer:customerId,
          currency:'eur',amount:p.minor,paid:true,captured:true};
      },
    };
    await assert.rejects(reviewStripeTestPaymentGroup(
      admin,evidence.invoiceId,groupProvider),
      /Dedicated invoice verifier role required/);
    assert.deepEqual(await reviewStripeTestPaymentGroup(
      verifier,evidence.invoiceId,groupProvider),
      {outcome:'recorded',reason:'group_observed'});
    const group=await admin.stripeTestInvoicePaymentGroup.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId},
    });
    assert.equal(group.tenantId,tenantA);
    assert.equal(group.subscriptionId,subscriptionRowId);
    assert.equal(group.observedPaymentCount,2);
    assert.equal(group.observedPaidMinor,1999n);
    assert.equal(group.refundGraphVerified,false);
    assert.equal(group.settlementVerified,false);
    assert.equal(group.financialClearance,false);
    assert.equal(group.billable,false);
    assert.deepEqual(await reviewStripeTestPaymentGroup(
      verifier,evidence.invoiceId,groupProvider),
      {outcome:'replayed',reason:'already_observed'});
    assert.equal(await admin.stripeTestInvoicePaymentGroup.count(),1);
    groupIncomplete=true;
    assert.deepEqual(await reviewStripeTestPaymentGroup(
      verifier,evidence.invoiceId,groupProvider),
      {outcome:'deferred',reason:'partial_list'});
    groupIncomplete=false;
    tamperedGroup=true;
    assert.deepEqual(await reviewStripeTestPaymentGroup(
      verifier,evidence.invoiceId,groupProvider),
      {outcome:'rejected',reason:'invalid_payment_graph'});
    tamperedGroup=false;
    assert.equal(await admin.stripeTestInvoicePaymentGroup.count(),1);
    await assert.rejects(admin.stripeTestInvoicePaymentGroup.update({
      where:{id:group.id},data:{observedPaidMinor:1n},
    }));
    await assert.rejects(admin.stripeTestInvoicePaymentGroup.delete({
      where:{id:group.id},
    }));
    const [groupGrants]=await admin.$queryRaw<Array<{
      runtimeRead:boolean;runtimeWrite:boolean;
      verifierInsert:boolean;verifierUpdate:boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime','stripe_test_invoice_payment_groups',
        'SELECT') AS "runtimeRead",
      has_table_privilege('melissa_runtime','stripe_test_invoice_payment_groups',
        'INSERT') AS "runtimeWrite",
      has_column_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_payment_groups','snapshot_sha256','INSERT')
        AS "verifierInsert",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_invoice_payment_groups','UPDATE')
        AS "verifierUpdate"`;
    assert.deepEqual(groupGrants,{
      runtimeRead:false,runtimeWrite:false,
      verifierInsert:true,verifierUpdate:false,
    });
    const [groupRls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_test_invoice_payment_groups'`;
    assert.deepEqual(groupRls,{relrowsecurity:true,relforcerowsecurity:true});
    await assert.rejects(runtime.stripeTestInvoicePaymentGroup.count());
    assert.equal(await admin.stripeTestInvoicePaymentGroup.count({
      where:{tenantId:tenantB},
    }),0);

    // ADR-119: multi-Charge risk review must cover EVERY Charge in the
    // already recorded group. All values are non-financial observations.
    const groupRefunds=new Map<string,Array<Record<string,unknown>>>();
    const groupDisputes=new Map<string,Array<Record<string,unknown>>>();
    let groupRiskIncomplete=false;
    let groupRiskForeign=false;
    const groupRiskProvider={
      ...groupProvider,
      listRefunds:async(id:string)=>{
        assert(id==='ch_group_1'||id==='ch_group_2');
        return {object:'list',has_more:groupRiskIncomplete&&id==='ch_group_2',
          data:groupRefunds.get(id)??[]};
      },
      listDisputes:async(id:string)=>{
        assert(id==='ch_group_1'||id==='ch_group_2');
        const original=groupDisputes.get(id)??[];
        return {object:'list',has_more:false,data:groupRiskForeign&&
          id==='ch_group_2'?original.map(x=>({...x,charge:'ch_foreign'})):
          original};
      },
    };
    await assert.rejects(reviewStripeTestGroupChargeRisk(
      admin,evidence.invoiceId,groupRiskProvider),
      /Dedicated invoice verifier role required/);
    assert.deepEqual(await reviewStripeTestGroupChargeRisk(
      verifier,evidence.invoiceId,groupRiskProvider),
      {outcome:'recorded',reason:'risk_observed'});
    let groupRisk=await admin.stripeTestGroupChargeRiskReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId},
    });
    assert.equal(groupRisk.groupId,group.id);
    assert.equal(groupRisk.tenantId,tenantA);
    assert.equal(groupRisk.observedChargeCount,2);
    assert.equal(groupRisk.observedRefundCount,0);
    assert.equal(groupRisk.refundGraphVerified,false);
    assert.equal(groupRisk.settlementVerified,false);
    assert.equal(groupRisk.financialClearance,false);
    assert.equal(groupRisk.billable,false);
    assert.deepEqual(await reviewStripeTestGroupChargeRisk(
      verifier,evidence.invoiceId,groupRiskProvider),
      {outcome:'replayed',reason:'already_observed'});
    groupRefunds.set('ch_group_1',[{
      object:'refund',id:'re_group_a',charge:'ch_group_1',
      payment_intent:'pi_group_1',livemode:false,currency:'eur',
      amount:250,status:'pending',
    }]);
    groupRefunds.set('ch_group_2',[{
      object:'refund',id:'re_group_b',charge:'ch_group_2',
      payment_intent:'pi_group_2',livemode:false,currency:'eur',
      amount:300,status:'succeeded',
    }]);
    groupDisputes.set('ch_group_2',[{
      object:'dispute',id:'du_group_b',charge:'ch_group_2',
      payment_intent:'pi_group_2',livemode:false,currency:'eur',
      amount:400,status:'under_review',
    }]);
    assert.deepEqual(await reviewStripeTestGroupChargeRisk(
      verifier,evidence.invoiceId,groupRiskProvider),
      {outcome:'recorded',reason:'risk_observed'});
    groupRisk=await admin.stripeTestGroupChargeRiskReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId,observedRefundCount:2},
    });
    assert.equal(groupRisk.succeededRefundMinor,300n);
    assert.equal(groupRisk.pendingRefundMinor,250n);
    assert.equal(groupRisk.observedDisputeCount,1);
    assert.equal(groupRisk.unresolvedDisputeCount,1);
    assert.equal(await admin.stripeTestGroupChargeRiskReview.count(),2);
    groupRiskIncomplete=true;
    assert.deepEqual(await reviewStripeTestGroupChargeRisk(
      verifier,evidence.invoiceId,groupRiskProvider),
      {outcome:'deferred',reason:'incomplete_risk_data'});
    groupRiskIncomplete=false;
    groupRiskForeign=true;
    assert.deepEqual(await reviewStripeTestGroupChargeRisk(
      verifier,evidence.invoiceId,groupRiskProvider),
      {outcome:'rejected',reason:'invalid_risk_graph'});
    groupRiskForeign=false;
    assert.equal(await admin.stripeGroupChargeRiskAttempt.count({
      where:{invoiceId:evidence.invoiceId},
    }),5);
    await assert.rejects(admin.stripeTestGroupChargeRiskReview.update({
      where:{id:groupRisk.id},data:{pendingRefundMinor:100n},
    }));
    await assert.rejects(admin.stripeTestGroupChargeRiskReview.delete({
      where:{id:groupRisk.id},
    }));
    await assert.rejects(runtime.stripeTestGroupChargeRiskReview.count());
    const [groupRiskGrants]=await admin.$queryRaw<Array<{
      runtimeRead:boolean;runtimeInsert:boolean;verifierInsert:boolean;
      verifierUpdate:boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime',
        'stripe_test_group_charge_risk_reviews','SELECT') AS "runtimeRead",
      has_table_privilege('melissa_runtime',
        'stripe_test_group_charge_risk_reviews','INSERT') AS "runtimeInsert",
      has_column_privilege('melissa_billing_invoice_verifier',
        'stripe_test_group_charge_risk_reviews','snapshot_sha256','INSERT')
        AS "verifierInsert",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_group_charge_risk_reviews','UPDATE') AS "verifierUpdate"`;
    assert.deepEqual(groupRiskGrants,{
      runtimeRead:false,runtimeInsert:false,
      verifierInsert:true,verifierUpdate:false,
    });
    const [groupRiskRls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_test_group_charge_risk_reviews'`;
    assert.deepEqual(groupRiskRls,{
      relrowsecurity:true,relforcerowsecurity:true,
    });
    assert.equal(await admin.stripeTestGroupChargeRiskReview.count({
      where:{tenantId:tenantB},
    }),0);

    // ADR-120: each Charge balance_transaction is verified directly from
    // Stripe TEST. An available Stripe balance does not imply bank payout.
    let missingBalance=false;
    let foreignBalance=false;
    let balanceAvailable=false;
    const balances={
      ...groupRiskProvider,
      retrieveCharge:async(id:string)=>{
        const original=await groupProvider.retrieveCharge(id);
        return {...original,balance_transaction:
          missingBalance&&id==='ch_group_2'?null:
            'txn_'+id};
      },
      retrieveBalanceTransaction:async(id:string)=>{
        assert(id==='txn_ch_group_1'||id==='txn_ch_group_2');
        const chargeId=id.slice(4);
        const amount=chargeId==='ch_group_1'?1000:999;
        return {object:'balance_transaction',id,source:foreignBalance&&
          chargeId==='ch_group_2'?'ch_foreign':chargeId,
          type:'charge',status:balanceAvailable?'available':'pending',
          currency:'eur',amount,fee:90,net:amount-90,
          available_on:paidAt+86400};
      },
    };
    await assert.rejects(reviewStripeTestGroupBalances(
      admin,evidence.invoiceId,balances),
      /Dedicated invoice verifier role required/);
    assert.deepEqual(await reviewStripeTestGroupBalances(
      verifier,evidence.invoiceId,balances),
      {outcome:'recorded',reason:'balance_observed'});
    let balance=await admin.stripeTestGroupBalanceReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId},
    });
    assert.equal(balance.groupId,group.id);
    assert.equal(balance.tenantId,tenantA);
    assert.equal(balance.grossMinor,1999n);
    assert.equal(balance.feeMinor,180n);
    assert.equal(balance.netMinor,1819n);
    assert.equal(balance.pendingTransactionCount,2);
    assert.equal(balance.availableTransactionCount,0);
    assert.equal(balance.payoutVerified,false);
    assert.equal(balance.settlementVerified,false);
    assert.equal(balance.financialClearance,false);
    assert.equal(balance.billable,false);
    assert.deepEqual(await reviewStripeTestGroupBalances(
      verifier,evidence.invoiceId,balances),
      {outcome:'replayed',reason:'already_observed'});
    balanceAvailable=true;
    assert.deepEqual(await reviewStripeTestGroupBalances(
      verifier,evidence.invoiceId,balances),
      {outcome:'recorded',reason:'balance_observed'});
    balance=await admin.stripeTestGroupBalanceReview.findFirstOrThrow({
      where:{invoiceId:evidence.invoiceId,availableTransactionCount:2},
    });
    assert.equal(balance.netMinor,1819n);
    assert.equal(balance.payoutVerified,false);
    assert.equal(await admin.stripeTestGroupBalanceReview.count(),2);
    missingBalance=true;
    assert.deepEqual(await reviewStripeTestGroupBalances(
      verifier,evidence.invoiceId,balances),
      {outcome:'deferred',reason:'balance_transaction_missing'});
    missingBalance=false;
    foreignBalance=true;
    assert.deepEqual(await reviewStripeTestGroupBalances(
      verifier,evidence.invoiceId,balances),
      {outcome:'rejected',reason:'invalid_balance_graph'});
    foreignBalance=false;
    assert.equal(await admin.stripeGroupBalanceAttempt.count({
      where:{invoiceId:evidence.invoiceId},
    }),5);
    await assert.rejects(admin.stripeTestGroupBalanceReview.update({
      where:{id:balance.id},data:{feeMinor:1n},
    }));
    await assert.rejects(admin.stripeTestGroupBalanceReview.delete({
      where:{id:balance.id},
    }));
    await assert.rejects(verifier.stripeTestGroupBalanceReview.delete({
      where:{id:balance.id},
    }));
    await assert.rejects(runtime.stripeTestGroupBalanceReview.count());
    const [balanceGrants]=await admin.$queryRaw<Array<{
      runtimeRead:boolean;runtimeInsert:boolean;verifierInsert:boolean;
      verifierUpdate:boolean;
    }>>`SELECT
      has_table_privilege('melissa_runtime',
        'stripe_test_group_balance_reviews','SELECT') AS "runtimeRead",
      has_table_privilege('melissa_runtime',
        'stripe_test_group_balance_reviews','INSERT') AS "runtimeInsert",
      has_column_privilege('melissa_billing_invoice_verifier',
        'stripe_test_group_balance_reviews','snapshot_sha256','INSERT')
        AS "verifierInsert",
      has_table_privilege('melissa_billing_invoice_verifier',
        'stripe_test_group_balance_reviews','UPDATE') AS "verifierUpdate"`;
    assert.deepEqual(balanceGrants,{
      runtimeRead:false,runtimeInsert:false,
      verifierInsert:true,verifierUpdate:false,
    });
    const [balanceRls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='stripe_test_group_balance_reviews'`;
    assert.deepEqual(balanceRls,{relrowsecurity:true,relforcerowsecurity:true});
    assert.equal(await admin.stripeTestGroupBalanceReview.count({
      where:{tenantId:tenantB},
    }),0);

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
