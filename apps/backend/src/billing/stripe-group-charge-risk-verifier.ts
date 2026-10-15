import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';
import { StripeTestPaymentRiskReader } from './stripe-test-payment-risk';
import { LinkedChargeRisk, parseStripeTestGroupChargeRisk } from './stripe-test-group-charge-risk';

export interface GroupChargeRiskProvider {
  retrieveInvoice(id: string): Promise<unknown>;
  retrieveSubscription(id: string): Promise<unknown>;
  listInvoicePayments(id: string): Promise<unknown>;
  retrievePaymentIntent(id: string): Promise<unknown>;
  retrieveCharge(id: string): Promise<unknown>;
  listRefunds(id: string): Promise<unknown>;
  listDisputes(id: string): Promise<unknown>;
}
export class StripeTestGroupChargeRiskReader
  extends StripeTestPaymentRiskReader
  implements GroupChargeRiskProvider {}

export type GroupRiskDecision = {
  outcome: 'recorded' | 'replayed' | 'deferred' | 'rejected';
  reason:
    | 'risk_observed'
    | 'already_observed'
    | 'group_not_observed'
    | 'provider_unavailable'
    | 'subscription_mismatch'
    | 'untrusted_checkout'
    | 'invoice_mismatch'
    | 'invalid_payment_graph'
    | 'partial_list'
    | 'invalid_risk_graph'
    | 'incomplete_risk_data';
};
function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

// Offline Stripe TEST only. This requires a pre-recorded immutable ADR-118
// payment group whose digest matches a freshly fetched full provider graph.
// All charges must return complete bounded refund/dispute lists; otherwise
// no observation is stored and the attempt is deferred.
// prettier-ignore
export async function reviewStripeTestGroupChargeRisk(
  db:PrismaClient,invoiceId:string,provider:GroupChargeRiskProvider,
):Promise<GroupRiskDecision>{
  if(!/^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId))
    throw new Error('Invalid Stripe TEST invoice ID');
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
    if(!evidence) throw new Error('Unknown bound Stripe TEST invoice');
    const audit=(outcome:GroupRiskDecision['outcome'],
      reason:GroupRiskDecision['reason']):Promise<GroupRiskDecision>=>
      tx.$executeRaw`
        INSERT INTO stripe_group_charge_risk_attempts
          (id,invoice_id,outcome,reason)
        VALUES(${randomUUID()}::uuid,${invoiceId},${outcome},${reason})`
      .then(()=>({outcome,reason}));
    if(evidence.billable||evidence.entitlementVerified)
      return audit('rejected','invoice_mismatch');
    const mapping=await tx.tenantSubscription.findFirst({
      where:{tenantId:evidence.tenantId,id:evidence.subscriptionId,
        provider:'stripe'},
      select:{tenantId:true,id:true,planId:true,providerCustomerId:true,
        providerSubscriptionId:true,checkoutSessionId:true},
    });
    if(!mapping||mapping.providerCustomerId!==evidence.providerCustomerId||
      mapping.providerSubscriptionId!==evidence.providerSubscriptionId)
      return audit('rejected','subscription_mismatch');
    const plan=await tx.billingPlan.findUnique({
      where:{id:mapping.planId},
      select:{active:true,currency:true,stripePriceId:true},
    });
    const checkout=mapping.checkoutSessionId
      ?await tx.stripeCheckoutIntent.findUnique({
        where:{checkoutSessionId:mapping.checkoutSessionId},
        select:{tenantId:true,planId:true,status:true,stripePriceId:true},
      }):null;
    if(!plan?.active||!plan.stripePriceId||
      plan.currency!==evidence.currency||!checkout||
      checkout.status!=='ready'||checkout.tenantId!==evidence.tenantId||
      checkout.planId!==mapping.planId||
      checkout.stripePriceId!==plan.stripePriceId)
      return audit('rejected','untrusted_checkout');

    let invoice:unknown,subscription:unknown,payments:unknown;
    try{
      [invoice,subscription,payments]=await Promise.all([
        provider.retrieveInvoice(invoiceId),
        provider.retrieveSubscription(evidence.providerSubscriptionId),
        provider.listInvoicePayments(invoiceId),
      ]);
    }catch{return audit('deferred','provider_unavailable');}
    const sub=stripeTestSubscriptionSnapshot(subscription);
    if(!sub||sub.id!==evidence.providerSubscriptionId||
      sub.customer!==evidence.providerCustomerId||
      sub.price!==plan.stripePriceId)
      return audit('rejected','subscription_mismatch');
    const paymentList=obj(payments),rows=paymentList?.data;
    if(paymentList?.object!=='list'||!Array.isArray(rows)||
      typeof paymentList.has_more!=='boolean'||rows.length>100)
      return audit('rejected','invalid_payment_graph');
    if(paymentList.has_more) return audit('deferred','partial_list');
    if(rows.length<2||rows.length>8)
      return audit('rejected','invalid_payment_graph');

    const charges:LinkedChargeRisk[]=[];
    for(const row of rows){
      const p=obj(row),link=obj(p?.payment),piId=link?.payment_intent;
      if(link?.type!=='payment_intent'||typeof piId!=='string'||
        !/^pi_[A-Za-z0-9_]{1,250}$/.test(piId))
        return audit('rejected','invalid_payment_graph');
      let pi:unknown;
      try{pi=await provider.retrievePaymentIntent(piId);}
      catch{return audit('deferred','provider_unavailable');}
      const chargeId=obj(pi)?.latest_charge;
      if(typeof chargeId!=='string'||!/^ch_[A-Za-z0-9_]{1,250}$/.test(chargeId))
        return audit('rejected','invalid_payment_graph');
      let charge:unknown,refunds:unknown,disputes:unknown;
      try{
        [charge,refunds,disputes]=await Promise.all([
          provider.retrieveCharge(chargeId),
          provider.listRefunds(chargeId),
          provider.listDisputes(chargeId),
        ]);
      }catch{return audit('deferred','provider_unavailable');}
      charges.push({paymentIntent:pi,charge,refunds,disputes});
    }
    const result=parseStripeTestGroupChargeRisk(invoice,payments,charges,{
      invoiceId,customerId:evidence.providerCustomerId,
      subscriptionId:evidence.providerSubscriptionId,
      currency:evidence.currency,amountPaidMinor:evidence.amountPaidMinor,
      paidAt:evidence.invoicePaidAt,
    });
    if(result.outcome!=='valid')
      return audit(
        result.outcome==='partial_list'||result.outcome==='incomplete_risk_data'
          ?'deferred':'rejected',
        result.outcome,
      );
    const snapshot=result.snapshot;
    const group=await tx.stripeTestInvoicePaymentGroup.findUnique({
      where:{invoiceId_snapshotSha256:{
        invoiceId,snapshotSha256:snapshot.groupDigest,
      }},select:{id:true,tenantId:true,subscriptionId:true,
        observedPaymentCount:true,refundGraphVerified:true},
    });
    if(!group||group.tenantId!==evidence.tenantId||
      group.subscriptionId!==evidence.subscriptionId||
      group.observedPaymentCount!==snapshot.chargeCount||
      group.refundGraphVerified)
      return audit('rejected','group_not_observed');
    const prior=await tx.stripeTestGroupChargeRiskReview.findUnique({
      where:{groupId_snapshotSha256:{
        groupId:group.id,snapshotSha256:snapshot.riskDigest,
      }},select:{id:true},
    });
    if(prior) return audit('replayed','already_observed');
    await tx.$executeRaw`
      INSERT INTO stripe_test_group_charge_risk_reviews
       (id,group_id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
        observed_charge_count,observed_refund_count,succeeded_refund_minor,
        pending_refund_minor,observed_dispute_count,unresolved_dispute_count)
      VALUES(${randomUUID()}::uuid,${group.id}::uuid,${invoiceId},
        ${evidence.tenantId}::uuid,${evidence.subscriptionId}::uuid,
        ${snapshot.riskDigest},${snapshot.chargeCount},
        ${snapshot.refundCount},${snapshot.succeededRefundMinor},
        ${snapshot.pendingRefundMinor},${snapshot.disputeCount},
        ${snapshot.unresolvedDisputeCount})`;
    return audit('recorded','risk_observed');
  },{timeout:180000});
}
