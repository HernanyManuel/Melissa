import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';

export type StripeReconcileReason =
  | 'provider_current'
  | 'no_known_subscription'
  | 'unsupported_event'
  | 'event_not_reconcilable'
  | 'provider_unavailable'
  | 'provider_mismatch'
  | 'price_mismatch'
  | 'invalid_provider_snapshot'
  | 'live_mode_forbidden';

export type StripeReconcileOutcome = 'applied' | 'unmapped' | 'rejected' | 'deferred' | 'skipped';

export interface StripeSubscriptionReader {
  retrieve(subscriptionId: string): Promise<unknown>;
}

export interface StripeReconciliationResult {
  outcome: StripeReconcileOutcome;
  reason: StripeReconcileReason;
}

// The signed webhook is only a trigger, never an authority for tenant,
// customer, product, price or current billing period.
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,250}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,250}$/;
const PRICE_ID = /^price_[A-Za-z0-9_-]{1,249}$/;
const STATUSES = new Set([
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused',
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventSubscriptionId(eventType: string, payload: unknown): string | null {
  const root = record(payload);
  const object = record(record(root?.data)?.object);
  if (!object) return null;
  let id: unknown;
  if (eventType === 'customer.subscription.created' ||
      eventType === 'customer.subscription.updated' ||
      eventType === 'customer.subscription.deleted') {
    id = object.id;
  } else if (eventType === 'checkout.session.completed') {
    id = object.subscription;
  } else if (eventType === 'invoice.paid' || eventType === 'invoice.payment_failed') {
    // Stripe Basil/Clover API versions put the subscription under parent.
    id = record(record(object.parent)?.subscription_details)?.subscription;
  } else {
    return null;
  }
  return typeof id === 'string' && SUBSCRIPTION_ID.test(id) ? id : null;
}

interface ProviderSnapshot {
  id: string;
  customer: string;
  price: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

function unixSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 1_000_000_000 && value < 253_402_300_800 ? value : null;
}

// Since 2025-03-31.basil Stripe removed top-level current_period_*.
// Multiple subscription items can have different billing periods; do not
// invent a single period for a multi-item or paginated subscription.
export function stripeTestSubscriptionSnapshot(value: unknown): ProviderSnapshot | null {
  const object = record(value);
  if (!object || object.object !== 'subscription' || object.livemode !== false ||
      typeof object.id !== 'string' || !SUBSCRIPTION_ID.test(object.id) ||
      typeof object.customer !== 'string' || !CUSTOMER_ID.test(object.customer) ||
      typeof object.status !== 'string' || !STATUSES.has(object.status) ||
      typeof object.cancel_at_period_end !== 'boolean')
    return null;
  const items = record(object.items);
  if (!items || !Array.isArray(items.data) || items.data.length !== 1 ||
      items.has_more === true)
    return null;
  const item = record(items.data[0]);
  const price = record(item?.price);
  if (!price || typeof price.id !== 'string' || !PRICE_ID.test(price.id))
    return null;
  const start = unixSeconds(item?.current_period_start);
  const end = unixSeconds(item?.current_period_end);
  if (start === null || end === null || end <= start) return null;
  const trialEnd = object.trial_end == null ? null : unixSeconds(object.trial_end);
  if (object.trial_end != null && trialEnd === null) return null;
  return {
    id: object.id,
    customer: object.customer,
    price: price.id,
    status: object.status,
    periodStart: new Date(start * 1000),
    periodEnd: new Date(end * 1000),
    cancelAtPeriodEnd: object.cancel_at_period_end,
    trialEnd: trialEnd === null ? null : new Date(trialEnd * 1000),
  };
}

// This explicitly-invoked test-mode reconciliation runs through a privileged
// administrative connection, NOT the public API or melissa_runtime. No new
// subscription may be provisioned by metadata or a webhook. Only a known,
// pre-linked subscription/Stripe customer and plan/price pair may be updated.
// Never grant paid entitlements based on the resulting status alone.
// prettier-ignore
export async function reconcileStoredStripeTestEvent(
  db: PrismaClient,
  eventId: string,
  provider: StripeSubscriptionReader,
): Promise<StripeReconciliationResult> {
  if (!/^evt_[A-Za-z0-9_]{1,251}$/.test(eventId))
    throw new Error('Invalid Stripe event identifier');
  const event = await db.stripeWebhookEvent.findUnique({ where: { eventId } });
  if (!event) throw new Error('Unknown stored Stripe event');

  const attempt = (
    outcome: StripeReconcileOutcome,
    reason: StripeReconcileReason,
    tenantId?: string,
    tx?: Prisma.TransactionClient,
  ) => (tx ?? db).stripeReconciliationAttempt.create({
    data: { id: randomUUID(), eventId, outcome, reason, tenantId },
  }).then(() => ({ outcome, reason }));

  if (event.livemode) return attempt('rejected', 'live_mode_forbidden');
  const eligible = [
    'customer.subscription.created', 'customer.subscription.updated',
    'customer.subscription.deleted', 'checkout.session.completed',
    'invoice.paid', 'invoice.payment_failed',
  ].includes(event.eventType);
  if (!eligible) return attempt('skipped', 'unsupported_event');
  const subscriptionId = eventSubscriptionId(event.eventType, event.payload);
  if (!subscriptionId) return attempt('rejected', 'event_not_reconcilable');

  const existing = await db.tenantSubscription.findFirst({
    where: { provider: 'stripe', providerSubscriptionId: subscriptionId },
  });
  // No inference from untrusted metadata. Checkout-created subscriptions
  // must first be bound through a separately validated checkout flow.
  if (!existing) return attempt('unmapped', 'no_known_subscription');

  return db.$transaction(async (tx) => {
    // Pessimistic row fencing serializes provider fetch + update for the same
    // linked subscription, so a stale parallel fetch cannot overwrite it.
    await tx.$queryRaw`
      SELECT id FROM subscriptions
      WHERE tenant_id=${existing.tenantId}::uuid AND id=${existing.id}::uuid
      FOR UPDATE
    `;
    const current = await tx.tenantSubscription.findUnique({
      where: { tenantId_id: { tenantId: existing.tenantId, id: existing.id } },
    });
    if (!current || current.provider !== 'stripe' ||
        current.providerSubscriptionId !== subscriptionId)
      return attempt('unmapped', 'no_known_subscription', undefined, tx);

    let snapshot: ProviderSnapshot | null;
    try {
      snapshot = stripeTestSubscriptionSnapshot(await provider.retrieve(subscriptionId));
    } catch {
      return attempt('deferred', 'provider_unavailable', undefined, tx);
    }
    if (!snapshot) return attempt('rejected', 'invalid_provider_snapshot', undefined, tx);
    if (snapshot.id !== subscriptionId || snapshot.customer !== current.providerCustomerId)
      return attempt('rejected', 'provider_mismatch', undefined, tx);
    const plan = await tx.billingPlan.findUnique({ where: { id: current.planId } });
    if (!plan || !plan.stripePriceId || plan.stripePriceId !== snapshot.price)
      return attempt('rejected', 'price_mismatch', undefined, tx);

    const updated = await tx.tenantSubscription.updateMany({
      where: {
        tenantId: current.tenantId,
        id: current.id,
        provider: 'stripe',
        providerCustomerId: current.providerCustomerId,
        providerSubscriptionId: subscriptionId,
        planId: current.planId,
      },
      data: {
        status: snapshot.status,
        currentPeriodStart: snapshot.periodStart,
        currentPeriodEnd: snapshot.periodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        trialEnd: snapshot.trialEnd,
        updatedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new Error('Subscription binding changed');
    return attempt('applied', 'provider_current', current.tenantId, tx);
  }, { timeout: 15000 });
}
