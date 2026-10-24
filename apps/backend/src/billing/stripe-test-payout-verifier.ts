import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';
import { LinkedBalanceCharge, parseStripeTestGroupBalances } from './stripe-test-group-balance';
import {
  ExpectedPayoutBalance,
  observeAutomaticStripeTestPayout,
} from './stripe-test-payout-observation';
import { StripeTestPayoutReader } from './stripe-test-payout-reader';
import { StripeTestGroupBalanceReader } from './stripe-group-balance-verifier';

// prettier-ignore
export interface StripeTestPayoutProvider {
  retrieveInvoice(id: string): Promise<unknown>;
  retrieveSubscription(id: string): Promise<unknown>;
  listInvoicePayments(id: string): Promise<unknown>;
  retrievePaymentIntent(id: string): Promise<unknown>;
  retrieveCharge(id: string): Promise<unknown>;
  retrieveBalanceTransaction(id: string): Promise<unknown>;
  retrievePayout(id: string): Promise<unknown>;
  listAutomaticPayoutTransactions(id: string): Promise<unknown>;
}
// prettier-ignore
export class StripeTestPayoutVerifierReader extends StripeTestPayoutReader {
  private readonly balances: StripeTestGroupBalanceReader;
  constructor(key: string, http: typeof fetch = fetch) {
    super(key, http);
    this.balances = new StripeTestGroupBalanceReader(key, http);
  }
  retrievePaymentIntent(id: string): Promise<unknown> { return this.balances.retrievePaymentIntent(id); }
  retrieveCharge(id: string): Promise<unknown> { return this.balances.retrieveCharge(id); }
  retrieveBalanceTransaction(id: string): Promise<unknown> { return this.balances.retrieveBalanceTransaction(id); }
  listInvoicePayments(id: string): Promise<unknown> { return this.balances.listInvoicePayments(id); }
}
// prettier-ignore
export interface PayoutReviewResult {
  outcome: 'recorded' | 'replayed' | 'rejected' | 'deferred';
  reason: string;
}
// prettier-ignore
function object(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? x as Record<string, unknown> : null;
}

// READ ONLY Stripe TEST calls. The operator supplies an invoice and payout ID,
// never a tenant, charge or balance ID. No payout/settlement authorisation.
// prettier-ignore
export async function reviewStripeTestAutomaticPayout(
  db: PrismaClient, invoiceId: string, payoutId: string,
  provider: StripeTestPayoutProvider,
): Promise<PayoutReviewResult> {
  if (!/^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId) ||
      !/^po_[A-Za-z0-9_]{1,250}$/.test(payoutId))
    throw new Error('Invalid Stripe TEST invoice or payout ID');
  const [role] = await db.$queryRaw<Array<{safe: boolean}>>`
    SELECT current_user='melissa_billing_invoice_verifier' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if (role?.safe !== true) throw new Error('Dedicated invoice verifier role required');

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${invoiceId},0)) IS NULL AS locked`;
    const evidence = await tx.stripeTestInvoiceEvidence.findUnique({
      where: { invoiceId }, select: {
        tenantId:true, subscriptionId:true, providerCustomerId:true,
        providerSubscriptionId:true, currency:true, amountPaidMinor:true,
        invoicePaidAt:true, billable:true, entitlementVerified:true,
      },
    });
    if (!evidence) throw new Error('Unknown bound TEST invoice');
    const audit = async (outcome:PayoutReviewResult['outcome'], reason:string):Promise<PayoutReviewResult> => {
      await tx.$executeRaw`
        INSERT INTO stripe_group_payout_attempts(id,invoice_id,outcome,reason)
        VALUES(${randomUUID()}::uuid,${invoiceId},${outcome},${reason})`;
      return {outcome, reason};
    };
    if (evidence.billable || evidence.entitlementVerified) return audit('rejected','untrusted_chain');
    const mapping = await tx.tenantSubscription.findFirst({
      where:{tenantId:evidence.tenantId,id:evidence.subscriptionId,provider:'stripe'},
      select:{id:true,planId:true,providerCustomerId:true,providerSubscriptionId:true,checkoutSessionId:true},
    });
    if (!mapping || mapping.providerCustomerId!==evidence.providerCustomerId ||
      mapping.providerSubscriptionId!==evidence.providerSubscriptionId)
      return audit('rejected','untrusted_chain');
    const plan=await tx.billingPlan.findUnique({where:{id:mapping.planId},
      select:{active:true,currency:true,stripePriceId:true}});
    const checkout=mapping.checkoutSessionId
      ?await tx.stripeCheckoutIntent.findUnique({where:{checkoutSessionId:mapping.checkoutSessionId},
        select:{tenantId:true,planId:true,status:true,stripePriceId:true}}):null;
    if(!plan?.active || !plan.stripePriceId || plan.currency!==evidence.currency ||
      !checkout || checkout.status!=='ready' || checkout.tenantId!==evidence.tenantId ||
      checkout.planId!==mapping.planId || checkout.stripePriceId!==plan.stripePriceId)
      return audit('rejected','untrusted_chain');

    let invoice:unknown, subscription:unknown, payments:unknown;
    try {
      [invoice,subscription,payments]=await Promise.all([
        provider.retrieveInvoice(invoiceId),provider.retrieveSubscription(evidence.providerSubscriptionId),
        provider.listInvoicePayments(invoiceId),
      ]);
    } catch { return audit('deferred','provider_unavailable'); }
    const sub=stripeTestSubscriptionSnapshot(subscription);
    if(!sub || sub.id!==evidence.providerSubscriptionId ||
      sub.customer!==evidence.providerCustomerId || sub.price!==plan.stripePriceId)
      return audit('rejected','untrusted_chain');
    const rows=object(payments)?.data;
    if(!Array.isArray(rows) || object(payments)?.object!=='list')
      return audit('rejected','untrusted_chain');
    if(object(payments)?.has_more!==false) return audit('deferred','partial_list');
    if(rows.length<2 || rows.length>8) return audit('rejected','untrusted_chain');

    const links:LinkedBalanceCharge[]=[];
    const expected:ExpectedPayoutBalance[]=[];
    for (const row of rows) {
      const ref=object(object(row)?.payment);
      const piId=ref?.payment_intent;
      if(ref?.type!=='payment_intent' || typeof piId!=='string' ||
        !/^pi_[A-Za-z0-9_]{1,250}$/.test(piId))
        return audit('rejected','untrusted_chain');
      let pi:unknown,charge:unknown,bt:unknown;
      try {
        pi=await provider.retrievePaymentIntent(piId);
        const chId=object(pi)?.latest_charge;
        if(typeof chId!=='string' || !/^ch_[A-Za-z0-9_]{1,250}$/.test(chId))
          return audit('rejected','untrusted_chain');
        charge=await provider.retrieveCharge(chId);
        const btId=object(charge)?.balance_transaction;
        if(typeof btId!=='string' || !/^txn_[A-Za-z0-9_]{1,250}$/.test(btId))
          return audit('deferred','provider_unavailable');
        bt=await provider.retrieveBalanceTransaction(btId);
      } catch { return audit('deferred','provider_unavailable'); }
      links.push({paymentIntent:pi,charge,balanceTransaction:bt});
      const transaction=object(bt);
      const chargeId=object(charge)?.id;
      if(typeof transaction?.id!=='string'||typeof chargeId!=='string'||
        typeof transaction.net!=='number')
        return audit('rejected','untrusted_chain');
      expected.push({id:transaction.id,source:chargeId,currency:evidence.currency.toLowerCase(),
        netMinor:transaction.net});
    }
    const parsed=parseStripeTestGroupBalances(invoice,payments,links,{
      invoiceId,customerId:evidence.providerCustomerId,
      subscriptionId:evidence.providerSubscriptionId,currency:evidence.currency,
      amountPaidMinor:evidence.amountPaidMinor,paidAt:evidence.invoicePaidAt,
    });
    if(parsed.outcome!=='valid') return audit(parsed.outcome==='partial_list'||
      parsed.outcome==='balance_transaction_missing'?'deferred':'rejected',
      parsed.outcome==='partial_list'?'partial_list':'untrusted_chain');
    if(parsed.snapshot.pendingCount!==0) return audit('deferred','unreconciled_payout');
    const group=await tx.stripeTestInvoicePaymentGroup.findUnique({
      where:{invoiceId_snapshotSha256:{invoiceId,snapshotSha256:parsed.snapshot.groupDigest}},
      select:{id:true,tenantId:true,subscriptionId:true,observedPaymentCount:true,
        observedPaidMinor:true,refundGraphVerified:true,billable:true},
    });
    if(!group || group.tenantId!==evidence.tenantId ||
      group.subscriptionId!==evidence.subscriptionId || group.billable ||
      group.refundGraphVerified || group.observedPaymentCount!==parsed.snapshot.chargeCount ||
      group.observedPaidMinor!==parsed.snapshot.grossMinor)
      return audit('rejected','untrusted_chain');
    const risk=await tx.stripeTestGroupChargeRiskReview.findFirst({
      where:{groupId:group.id,tenantId:evidence.tenantId,
        subscriptionId:evidence.subscriptionId,financialClearance:false,billable:false},
      select:{id:true},
    });
    const balance=await tx.stripeTestGroupBalanceReview.findUnique({
      where:{groupId_snapshotSha256:{groupId:group.id,
        snapshotSha256:parsed.snapshot.balanceDigest}},
      select:{id:true,netMinor:true,pendingTransactionCount:true},
    });
    if(!risk || !balance || balance.netMinor!==parsed.snapshot.netMinor ||
      balance.pendingTransactionCount!==0) return audit('rejected','untrusted_chain');

    let payout:unknown,list:unknown;
    try {
      payout=await provider.retrievePayout(payoutId);
      list=await provider.listAutomaticPayoutTransactions(payoutId);
    } catch { return audit('deferred','provider_unavailable'); }
    const result=observeAutomaticStripeTestPayout(payout,list,expected);
    if(result.outcome!=='observed') {
      const reasons:Record<string,string>={
        partial_list:'partial_list',manual_payout_not_attributable:'manual_payout',
        payout_not_reconciled:'unreconciled_payout',
        group_not_fully_in_payout:'group_not_in_payout',
        transaction_mismatch:'transaction_mismatch',
      };
      return audit(result.outcome,reasons[result.reason]??'invalid_payout');
    }
    if(result.payoutId!==payoutId) return audit('rejected','invalid_payout');
    if(result.observedNetMinor!==balance.netMinor ||
      result.includedCount!==parsed.snapshot.chargeCount)
      return audit('rejected','transaction_mismatch');
    const prior=await tx.stripeTestGroupPayoutObservation.findUnique({
      where:{balanceReviewId_payoutId_snapshotSha256:{
        balanceReviewId:balance.id,payoutId,snapshotSha256:result.digest}},
      select:{id:true},
    });
    if(prior) return audit('replayed','already_observed');
    await tx.$executeRaw`
      INSERT INTO stripe_test_group_payout_observations
       (id,balance_review_id,group_id,invoice_id,tenant_id,subscription_id,
        payout_id,snapshot_sha256,included_charge_count,observed_net_minor)
      VALUES(${randomUUID()}::uuid,${balance.id}::uuid,${group.id}::uuid,
        ${invoiceId},${evidence.tenantId}::uuid,${evidence.subscriptionId}::uuid,
        ${payoutId},${result.digest},${result.includedCount},${result.observedNetMinor})`;
    return audit('recorded','payout_observed');
  }, {timeout:180000});
}
