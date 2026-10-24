import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';
import { parseStripeTestPaymentGroup } from './stripe-test-payment-group';

export interface StripeTestPaymentGroupProvider {
  retrieveInvoice(id: string): Promise<unknown>;
  retrieveSubscription(id: string): Promise<unknown>;
  listInvoicePayments(id: string): Promise<unknown>;
  retrievePaymentIntent(id: string): Promise<unknown>;
  retrieveCharge(id: string): Promise<unknown>;
}
type Outcome = 'recorded' | 'replayed' | 'deferred' | 'rejected';
type Reason =
  | 'group_observed'
  | 'already_observed'
  | 'provider_unavailable'
  | 'untrusted_checkout'
  | 'subscription_mismatch'
  | 'invoice_mismatch'
  | 'partial_list'
  | 'unsupported_payment_count'
  | 'invalid_payment_graph';
export interface PaymentGroupDecision {
  outcome: Outcome;
  reason: Reason;
}
function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

// No PI/Charge references are accepted from the operator. All links are
// resolved through the restricted tenant-bound paid-invoice evidence and
// fresh Stripe TEST GET responses. This deliberately observes multi-payment
// provenance, NOT multiple-charge refund/dispute reconciliation or clearing.
// prettier-ignore
export async function reviewStripeTestPaymentGroup(
  db:PrismaClient,invoiceId:string,provider:StripeTestPaymentGroupProvider,
):Promise<PaymentGroupDecision>{
  if(!/^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId))
    throw new Error('Invalid test invoice');
  const [role]=await db.$queryRaw<Array<{safe:boolean}>>`
    SELECT current_user='melissa_billing_invoice_verifier' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if(role?.safe!==true) throw new Error('Dedicated invoice verifier role required');

  return db.$transaction(async tx=>{
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${invoiceId},0))
        IS NULL AS locked`;
    const evidence=await tx.stripeTestInvoiceEvidence.findUnique({
      where:{invoiceId},
      select:{
        tenantId:true,subscriptionId:true,providerCustomerId:true,
        providerSubscriptionId:true,currency:true,amountPaidMinor:true,
        invoicePaidAt:true,billable:true,entitlementVerified:true,
      },
    });
    if(!evidence) throw new Error('Unknown bound test invoice');
    const audit=(outcome:Outcome,reason:Reason):Promise<PaymentGroupDecision>=>
      tx.$executeRaw`
        INSERT INTO stripe_invoice_payment_group_attempts(id,invoice_id,outcome,reason)
        VALUES(${randomUUID()}::uuid,${invoiceId},${outcome},${reason})`
        .then(()=>({outcome,reason}));
    if(evidence.billable||evidence.entitlementVerified)
      return audit('rejected','invoice_mismatch');
    const mapping=await tx.tenantSubscription.findFirst({
      where:{tenantId:evidence.tenantId,id:evidence.subscriptionId,provider:'stripe'},
      select:{
        id:true,tenantId:true,planId:true,providerCustomerId:true,
        providerSubscriptionId:true,checkoutSessionId:true,
      },
    });
    if(!mapping||mapping.providerCustomerId!==evidence.providerCustomerId||
       mapping.providerSubscriptionId!==evidence.providerSubscriptionId)
      return audit('rejected','subscription_mismatch');
    const plan=await tx.billingPlan.findUnique({
      where:{id:mapping.planId},
      select:{active:true,currency:true,stripePriceId:true},
    });
    const checkout=mapping.checkoutSessionId
      ? await tx.stripeCheckoutIntent.findUnique({
          where:{checkoutSessionId:mapping.checkoutSessionId},
          select:{tenantId:true,planId:true,status:true,stripePriceId:true},
        }):null;
    if(!plan?.active||!plan.stripePriceId||plan.currency!==evidence.currency||
       !checkout||checkout.tenantId!==evidence.tenantId||
       checkout.planId!==mapping.planId||
       checkout.stripePriceId!==plan.stripePriceId||
       checkout.status!=='ready')
      return audit('rejected','untrusted_checkout');

    let invoiceRaw:unknown,subRaw:unknown,paymentsRaw:unknown;
    try{
      [invoiceRaw,subRaw,paymentsRaw]=await Promise.all([
        provider.retrieveInvoice(invoiceId),
        provider.retrieveSubscription(evidence.providerSubscriptionId),
        provider.listInvoicePayments(invoiceId),
      ]);
    }catch{return audit('deferred','provider_unavailable');}
    const sub=stripeTestSubscriptionSnapshot(subRaw);
    if(!sub||sub.id!==evidence.providerSubscriptionId||
       sub.customer!==evidence.providerCustomerId||
       sub.price!==plan.stripePriceId)
      return audit('rejected','subscription_mismatch');
    const list=obj(paymentsRaw),rows=list?.data;
    if(list?.object!=='list'||!Array.isArray(rows)||
       typeof list.has_more!=='boolean'||rows.length>100)
      return audit('rejected','invalid_payment_graph');
    if(list.has_more) return audit('deferred','partial_list');
    if(rows.length<2||rows.length>8)
      return audit('rejected','unsupported_payment_count');

    const links:Array<{paymentIntent:unknown;charge:unknown}>=[];
    for(const item of rows){
      const pay=obj(item),link=obj(pay?.payment);
      const piId=link?.payment_intent;
      if(link?.type!=='payment_intent'||typeof piId!=='string'||
         !/^pi_[A-Za-z0-9_]{1,250}$/.test(piId))
        return audit('rejected','invalid_payment_graph');
      let pi:unknown;
      try{pi=await provider.retrievePaymentIntent(piId);}
      catch{return audit('deferred','provider_unavailable');}
      const chargeId=obj(pi)?.latest_charge;
      if(typeof chargeId!=='string'||!/^ch_[A-Za-z0-9_]{1,250}$/.test(chargeId))
        return audit('rejected','invalid_payment_graph');
      let charge:unknown;
      try{charge=await provider.retrieveCharge(chargeId);}
      catch{return audit('deferred','provider_unavailable');}
      links.push({paymentIntent:pi,charge});
    }
    const result=parseStripeTestPaymentGroup(invoiceRaw,paymentsRaw,links,{
      invoiceId,customerId:evidence.providerCustomerId,
      subscriptionId:evidence.providerSubscriptionId,
      currency:evidence.currency,amountPaidMinor:evidence.amountPaidMinor,
      paidAt:evidence.invoicePaidAt,
    });
    if(result.outcome!=='valid')
      return audit(result.outcome==='partial_list'?'deferred':'rejected',
        result.outcome);
    const snapshot=result.snapshot;
    const prior=await tx.stripeTestInvoicePaymentGroup.findUnique({
      where:{invoiceId_snapshotSha256:{
        invoiceId,snapshotSha256:snapshot.digest,
      }},select:{id:true},
    });
    if(prior) return audit('replayed','already_observed');
    await tx.$executeRaw`
      INSERT INTO stripe_test_invoice_payment_groups
        (id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
         observed_payment_count,observed_paid_minor)
      VALUES(${randomUUID()}::uuid,${invoiceId},${evidence.tenantId}::uuid,
        ${evidence.subscriptionId}::uuid,${snapshot.digest},
        ${snapshot.count},${snapshot.paidMinor})`;
    return audit('recorded','group_observed');
  },{timeout:120000});
}
