import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  StripeInvoiceEvidenceProvider,
  stripeTestPaidInvoiceSnapshot,
  stripeTestSubscriptionSnapshot,
} from './stripe-test-invoice-reader';

export type InvoiceEvidenceOutcome = 'recorded' | 'replayed' | 'rejected' | 'deferred';
export type InvoiceEvidenceReason =
  | 'provider_verified'
  | 'already_recorded'
  | 'unsupported_event'
  | 'unknown_subscription'
  | 'invalid_provider_snapshot'
  | 'provider_unavailable'
  | 'invoice_mismatch'
  | 'subscription_mismatch'
  | 'untrusted_checkout'
  | 'binding_conflict';
export interface InvoiceEvidenceResult {
  outcome: InvoiceEvidenceOutcome;
  reason: InvoiceEvidenceReason;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The signed inbox supplies ONLY an invoice ID, never a tenant or an
// amount. The REST provider is freshly queried and mapped to a prior
// tenant-owned Checkout subscription by immutable Stripe identifiers.
// ALL evidence remains non-billable and cannot grant paid entitlements.
// prettier-ignore
export async function recordStoredStripeTestInvoice(
  db: PrismaClient, eventId: string, provider: StripeInvoiceEvidenceProvider,
): Promise<InvoiceEvidenceResult> {
  if (!/^evt_[A-Za-z0-9_]{1,251}$/.test(eventId))
    throw new Error('Invalid signed event ID');
  const [role] = await db.$queryRaw<Array<{ safe: boolean }>>`
    SELECT current_user='melissa_billing_invoice_verifier' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if (role?.safe !== true) throw new Error('Dedicated invoice verifier role required');
  const event = await db.stripeWebhookEvent.findUnique({
    where: { eventId }, select: { eventType: true,livemode: true,payload: true },
  });
  if (!event) throw new Error('Unknown signed invoice event');

  const audit = (
    dbOrTx: PrismaClient | Prisma.TransactionClient,
    outcome: InvoiceEvidenceOutcome,
    reason: InvoiceEvidenceReason,
  ): Promise<InvoiceEvidenceResult> => dbOrTx.$executeRaw`
      INSERT INTO stripe_invoice_evidence_attempts(id,event_id,outcome,reason)
      VALUES (${randomUUID()}::uuid,${eventId},${outcome},${reason})`
    .then(() => ({ outcome,reason }));

  const signed = obj(obj(obj(event.payload)?.data)?.object);
  if (event.livemode !== false || event.eventType !== 'invoice.paid' ||
      signed?.object !== 'invoice' || typeof signed.id !== 'string' ||
      !/^in_[A-Za-z0-9_]{1,250}$/.test(signed.id))
    return audit(db, 'rejected','unsupported_event');
  const invoiceId = signed.id as string;

  let invoice;
  try {
    invoice = stripeTestPaidInvoiceSnapshot(await provider.retrieveInvoice(invoiceId));
  } catch {
    return audit(db,'deferred','provider_unavailable');
  }
  if (!invoice || invoice.id !== invoiceId)
    return audit(db,'rejected','invalid_provider_snapshot');

  const mapping = await db.tenantSubscription.findFirst({
    where: { provider:'stripe', providerSubscriptionId:invoice.subscription },
    select: {
      id:true,tenantId:true,planId:true,providerCustomerId:true,
      providerSubscriptionId:true,checkoutSessionId:true,status:true,
    },
  });
  if (!mapping) return audit(db,'rejected','unknown_subscription');

  let snapshot;
  try {
    snapshot = stripeTestSubscriptionSnapshot(
      await provider.retrieveSubscription(invoice.subscription),
    );
  } catch {
    return audit(db,'deferred','provider_unavailable');
  }
  if (!snapshot)
    return audit(db,'rejected','invalid_provider_snapshot');
  if (snapshot.id !== mapping.providerSubscriptionId ||
      snapshot.customer !== invoice.customer ||
      mapping.providerCustomerId !== invoice.customer)
    return audit(db,'rejected','subscription_mismatch');

  return db.$transaction(async (tx) => {
    // Lock invoice identity across retries. The query returns a boolean,
    // never the PostgreSQL void type Prisma cannot deserialize.
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${invoiceId},0))
        IS NULL AS locked`;

    const row = await tx.tenantSubscription.findFirst({
      where: { provider:'stripe',providerSubscriptionId:invoice.subscription },
      select: {
        id:true,tenantId:true,planId:true,providerCustomerId:true,
        providerSubscriptionId:true,checkoutSessionId:true,status:true,
      },
    });
    if (!row || row.id !== mapping.id || row.tenantId !== mapping.tenantId ||
        row.planId !== mapping.planId || row.providerCustomerId !== invoice.customer)
      return audit(tx,'rejected','binding_conflict');
    const plan = await tx.billingPlan.findUnique({
      where:{id:row.planId},
      select:{currency:true,stripePriceId:true,active:true},
    });
    if (!plan?.active || !plan.stripePriceId ||
        plan.currency !== invoice.currency ||
        snapshot.price !== plan.stripePriceId)
      return audit(tx,'rejected','invoice_mismatch');
    const checkout = row.checkoutSessionId
      ? await tx.stripeCheckoutIntent.findUnique({
          where:{checkoutSessionId:row.checkoutSessionId},
          select:{tenantId:true,planId:true,stripePriceId:true,status:true},
        })
      : null;
    if (!checkout || checkout.tenantId !== row.tenantId ||
        checkout.planId !== row.planId || checkout.status !== 'ready' ||
        checkout.stripePriceId !== plan.stripePriceId)
      return audit(tx,'rejected','untrusted_checkout');

    const prior = await tx.stripeTestInvoiceEvidence.findUnique({
      where:{invoiceId},
      select:{
        tenantId:true,subscriptionId:true,providerCustomerId:true,
        providerSubscriptionId:true,currency:true,amountPaidMinor:true,
        invoicePaidAt:true,
      },
    });
    if (prior) {
      const same = prior.tenantId === row.tenantId &&
        prior.subscriptionId === row.id &&
        prior.providerCustomerId === invoice.customer &&
        prior.providerSubscriptionId === invoice.subscription &&
        prior.currency === invoice.currency &&
        prior.amountPaidMinor === invoice.amountPaidMinor &&
        prior.invoicePaidAt.getTime() === invoice.paidAt.getTime();
      return audit(tx,same?'replayed':'rejected',
        same?'already_recorded':'binding_conflict');
    }
    // The RLS INSERT policy also fences local ownership and signed event ID.
    await tx.$executeRaw`
      INSERT INTO stripe_test_invoice_evidence
        (invoice_id,tenant_id,subscription_id,source_event_id,
         provider_customer_id,provider_subscription_id,currency,
         amount_paid_minor,invoice_paid_at)
      VALUES (${invoice.id},${row.tenantId}::uuid,${row.id}::uuid,
        ${eventId},${invoice.customer},${invoice.subscription},
        ${invoice.currency},${invoice.amountPaidMinor},${invoice.paidAt})`;
    return audit(tx,'recorded','provider_verified');
  }, {timeout:20000});
}
