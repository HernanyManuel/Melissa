import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';
import { parseStripeTestPaymentRisk, StripePaymentRiskProvider } from './stripe-test-payment-risk';

export interface VerifiedRiskProvider extends StripePaymentRiskProvider {
  retrieveSubscription(id: string): Promise<unknown>;
}
export type RiskDecision = {
  outcome: 'recorded' | 'replayed' | 'rejected' | 'deferred';
  reason:
    | 'snapshot_observed'
    | 'already_observed'
    | 'provider_unavailable'
    | 'invoice_mismatch'
    | 'subscription_mismatch'
    | 'untrusted_checkout'
    | 'payment_mapping_invalid'
    | 'payment_mapping_incomplete'
    | 'charge_mismatch'
    | 'invalid_refund_list'
    | 'invalid_dispute_list'
    | 'incomplete_risk_data';
};
function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

// Only explicit offline test invocations. Payment IDs must come from the
// authenticated Stripe InvoicePayment chain, not metadata, HTTP or stored
// client-supplied charge IDs. All snapshots remain permanently deny-only.
// prettier-ignore
export async function reviewStripeTestPaymentRisk(
  db:PrismaClient, invoiceId:string, provider:VerifiedRiskProvider,
):Promise<RiskDecision>{
  if(!/^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId))
    throw new Error('Invalid test invoice ID');
  const [role]=await db.$queryRaw<Array<{safe:boolean}>>`
    SELECT current_user='melissa_billing_invoice_verifier' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if(role?.safe!==true) throw new Error('Dedicated invoice verifier role required');
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${invoiceId},0))
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
    const audit=(outcome:RiskDecision['outcome'],reason:RiskDecision['reason'])
      :Promise<RiskDecision>=>tx.$executeRaw`
      INSERT INTO stripe_payment_risk_attempts(id,invoice_id,outcome,reason)
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
      ?await tx.stripeCheckoutIntent.findUnique({
          where:{checkoutSessionId:mapping.checkoutSessionId},
          select:{tenantId:true,planId:true,stripePriceId:true,status:true},
        }):null;
    if(!plan?.active||!plan.stripePriceId||
       plan.currency!==evidence.currency||!checkout||
       checkout.tenantId!==evidence.tenantId||
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
    if(list?.object!=='list'||!Array.isArray(rows)||rows.length!==1||
       typeof list.has_more!=='boolean')
      return audit('rejected','payment_mapping_invalid');
    if(list.has_more) return audit('deferred','payment_mapping_incomplete');
    const pay=obj(rows[0]),link=obj(pay?.payment);
    const piId=link?.payment_intent;
    if(pay?.object!=='invoice_payment'||pay.livemode!==false||
       pay.invoice!==invoiceId||pay.status!=='paid'||
       link?.type!=='payment_intent'||
       typeof piId!=='string'||!/^pi_[A-Za-z0-9_]{1,250}$/.test(piId))
      return audit('rejected','payment_mapping_invalid');
    let pi:unknown;
    try{pi=await provider.retrievePaymentIntent(piId);}
    catch{return audit('deferred','provider_unavailable');}
    const chargeId=obj(pi)?.latest_charge;
    if(typeof chargeId!=='string'||!/^ch_[A-Za-z0-9_]{1,250}$/.test(chargeId))
      return audit('rejected','charge_mismatch');
    let charge:unknown,refunds:unknown,disputes:unknown;
    try{
      [charge,refunds,disputes]=await Promise.all([
        provider.retrieveCharge(chargeId),
        provider.listRefunds(chargeId),
        provider.listDisputes(chargeId),
      ]);
    }catch{return audit('deferred','provider_unavailable');}
    const parsed=parseStripeTestPaymentRisk(
      invoiceRaw,paymentsRaw,pi,charge,refunds,disputes,{
        invoiceId,customerId:evidence.providerCustomerId,
        subscriptionId:evidence.providerSubscriptionId,
        currency:evidence.currency,amountPaidMinor:evidence.amountPaidMinor,
        paidAt:evidence.invoicePaidAt,
      },
    );
    if(parsed.outcome!=='valid')
      return audit(
        ['incomplete_risk_data','payment_mapping_incomplete'].includes(parsed.outcome)
          ?'deferred':'rejected',parsed.outcome,
      );
    const snapshot=parsed.snapshot;
    const prior=await tx.stripeTestPaymentRiskReview.findUnique({
      where:{invoiceId_snapshotSha256:{
        invoiceId,snapshotSha256:snapshot.snapshotSha256,
      }},select:{id:true},
    });
    if(prior) return audit('replayed','already_observed');
    await tx.$executeRaw`
      INSERT INTO stripe_test_payment_risk_reviews
        (id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
         payment_intent_id,charge_id,refund_count,succeeded_refund_minor,
         pending_refund_minor,dispute_count,unresolved_dispute_count)
      VALUES(${randomUUID()}::uuid,${invoiceId},${evidence.tenantId}::uuid,
        ${evidence.subscriptionId}::uuid,${snapshot.snapshotSha256},
        ${snapshot.paymentIntentId},${snapshot.chargeId},
        ${snapshot.refundCount},${snapshot.succeededRefundMinor},
        ${snapshot.pendingRefundMinor},${snapshot.disputeCount},
        ${snapshot.unresolvedDisputeCount})`;
    return audit('recorded','snapshot_observed');
  },{timeout:35000});
}
