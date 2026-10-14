import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';
import {
  parseStripeTestInvoiceReview,
  StripeInvoiceReviewProvider,
} from './stripe-test-invoice-review';

export type InvoiceReviewOutcome = 'recorded' | 'replayed' | 'rejected' | 'deferred';
export type InvoiceReviewReason =
  | 'snapshot_observed'
  | 'already_observed'
  | 'provider_unavailable'
  | 'invalid_period'
  | 'invalid_credit_notes'
  | 'incomplete_credits'
  | 'invoice_mismatch'
  | 'subscription_mismatch'
  | 'untrusted_checkout';

export interface InvoiceReviewResult {
  outcome: InvoiceReviewOutcome;
  reason: InvoiceReviewReason;
}

// Deliberate TEST-only offline review. The dispatcher/API runtime cannot
// perform this operation and do not receive invoice period or credit amounts.
// A paid invoice does not prove final settlement or absence of refunds.
// prettier-ignore
export async function reviewStoredStripeTestInvoice(
  db: PrismaClient,
  invoiceId: string,
  provider: StripeInvoiceReviewProvider,
): Promise<InvoiceReviewResult> {
  if (!/^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId))
    throw new Error('Invalid invoice ID');
  const [role] = await db.$queryRaw<Array<{ safe: boolean }>>`
    SELECT current_user='melissa_billing_invoice_verifier' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if (role?.safe !== true) throw new Error('Dedicated invoice verifier role required');

  return db.$transaction(async(tx) => {
    // Serializes all reviews of one invoice; Prisma must not decode void.
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
    if (!evidence) throw new Error('Unknown bound test invoice');
    const audit=(
      outcome:InvoiceReviewOutcome,reason:InvoiceReviewReason,
    ):Promise<InvoiceReviewResult>=>tx.$executeRaw`
      INSERT INTO stripe_invoice_review_attempts(id,invoice_id,outcome,reason)
      VALUES(${randomUUID()}::uuid,${invoiceId},${outcome},${reason})`
      .then(()=>({outcome,reason}));

    if (evidence.billable || evidence.entitlementVerified)
      return audit('rejected','invoice_mismatch');
    const mapping=await tx.tenantSubscription.findFirst({
      where:{
        tenantId:evidence.tenantId,id:evidence.subscriptionId,provider:'stripe',
      },
      select:{
        tenantId:true,id:true,planId:true,providerCustomerId:true,
        providerSubscriptionId:true,checkoutSessionId:true,
      },
    });
    if (!mapping || mapping.providerCustomerId!==evidence.providerCustomerId ||
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
        })
      : null;
    if (!plan?.active || !plan.stripePriceId || plan.currency!==evidence.currency ||
        !checkout || checkout.tenantId!==evidence.tenantId ||
        checkout.planId!==mapping.planId || checkout.status!=='ready' ||
        checkout.stripePriceId!==plan.stripePriceId)
      return audit('rejected','untrusted_checkout');

    let invoiceValue:unknown,subscriptionValue:unknown,noteListValue:unknown;
    try {
      invoiceValue=await provider.retrieveInvoice(invoiceId);
      subscriptionValue=await provider.retrieveSubscription(evidence.providerSubscriptionId);
      noteListValue=await provider.listCreditNotes(invoiceId);
    } catch {
      return audit('deferred','provider_unavailable');
    }
    const providerSub=stripeTestSubscriptionSnapshot(subscriptionValue);
    if (!providerSub || providerSub.id!==evidence.providerSubscriptionId ||
        providerSub.customer!==evidence.providerCustomerId ||
        providerSub.price!==plan.stripePriceId)
      return audit('rejected','subscription_mismatch');

    const parsed=parseStripeTestInvoiceReview(invoiceValue,noteListValue,{
      invoiceId,customerId:evidence.providerCustomerId,
      subscriptionId:evidence.providerSubscriptionId,
      priceId:plan.stripePriceId,currency:evidence.currency,
      amountPaidMinor:evidence.amountPaidMinor,
      paidAt:evidence.invoicePaidAt,
    });
    if (parsed.outcome!=='valid')
      return audit(parsed.outcome==='incomplete_credits'?'deferred':'rejected',
        parsed.outcome);
    const snapshot=parsed.snapshot;
    const prior=await tx.stripeTestInvoiceReview.findUnique({
      where:{invoiceId_snapshotSha256:{invoiceId,snapshotSha256:snapshot.digest}},
      select:{id:true},
    });
    if (prior) return audit('replayed','already_observed');
    await tx.$executeRaw`
      INSERT INTO stripe_test_invoice_reviews
        (id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
         line_price_id,service_period_start,service_period_end,
         credit_note_count,issued_credit_minor)
      VALUES(${randomUUID()}::uuid,${invoiceId},${evidence.tenantId}::uuid,
        ${evidence.subscriptionId}::uuid,${snapshot.digest},${snapshot.priceId},
        ${snapshot.periodStart},${snapshot.periodEnd},
        ${snapshot.creditNoteCount},${snapshot.issuedCreditMinor})`;
    return audit('recorded','snapshot_observed');
  },{timeout:20000});
}
