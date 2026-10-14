import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';
import {
  StripeCheckoutLinkProvider,
  stripeTestCheckoutSessionSnapshot,
} from './stripe-test-checkout-session-reader';

export type CheckoutLinkOutcome = 'linked' | 'replayed' | 'rejected' | 'deferred';
export type CheckoutLinkReason =
  | 'provider_verified' | 'already_linked' | 'event_not_eligible'
  | 'unknown_checkout' | 'intent_not_ready' | 'provider_unavailable'
  | 'invalid_provider_snapshot' | 'session_mismatch'
  | 'subscription_mismatch' | 'payment_not_verified' | 'binding_conflict';
export interface CheckoutLinkResult {
  outcome: CheckoutLinkOutcome;
  reason: CheckoutLinkReason;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

// ADR-110: an OFFLINE, operator-invoked test-only importer. The signed webhook
// provides ONLY a Checkout Session ID. ALL billing IDs and state come from
// fresh provider GETs; tenant/plan come from the previously stored intent.
// prettier-ignore
export async function linkStoredStripeTestCheckout(
  db: PrismaClient, eventId: string, provider: StripeCheckoutLinkProvider,
): Promise<CheckoutLinkResult> {
  if (!/^evt_[A-Za-z0-9_]{1,251}$/.test(eventId))
    throw new Error('Invalid Stripe event ID');
  const [role] = await db.$queryRaw<Array<{ safe: boolean }>>`
    SELECT current_user='melissa_billing_linker' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if (role?.safe !== true) throw new Error('Dedicated Stripe linker role required');
  const event = await db.stripeWebhookEvent.findUnique({
    where: { eventId },
    select: { eventType: true, livemode: true, payload: true },
  });
  if (!event) throw new Error('Unknown signed event');

  const audit = (
    tx: Prisma.TransactionClient | PrismaClient,
    outcome: CheckoutLinkOutcome, reason: CheckoutLinkReason,
    intentId?: string, tenantId?: string,
  ) => tx.$executeRaw`
    INSERT INTO stripe_checkout_link_attempts
      (id,event_id,intent_id,tenant_id,outcome,reason)
    VALUES (${randomUUID()}::uuid,${eventId},
      ${intentId ?? null}::uuid,${tenantId ?? null}::uuid,
      ${outcome},${reason})`
    .then(() => ({ outcome, reason }));
  const signed = object(object(object(event.payload)?.data)?.object);
  if (event.livemode !== false || event.eventType !== 'checkout.session.completed' ||
      signed?.object !== 'checkout.session' ||
      typeof signed.id !== 'string' || !/^cs_test_[A-Za-z0-9_]{1,240}$/.test(signed.id))
    return audit(db, 'rejected', 'event_not_eligible');

  const sessionId = signed.id as string;
  const intent = await db.stripeCheckoutIntent.findUnique({
    where: { checkoutSessionId: sessionId },
    select: {
      id: true, tenantId: true, planId: true, stripePriceId: true,
      checkoutSessionId: true, status: true, expiresAt: true, createdAt: true,
    },
  });
  if (!intent) return audit(db, 'rejected', 'unknown_checkout');
  if (intent.status !== 'ready')
    return audit(db, 'rejected', 'intent_not_ready', intent.id);

  return db.$transaction(async (tx) => {
    // One transactional lock per original intent prevents concurrent replays
    // from racing insert/audit. Unique DB constraints also fence other tenants.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${intent.id},0))`;
    const current = await tx.stripeCheckoutIntent.findUnique({
      where: { id: intent.id },
      select: {
        id: true, tenantId: true, planId: true, stripePriceId: true,
        checkoutSessionId: true, status: true, expiresAt: true, createdAt: true,
      },
    });
    if (!current || current.status !== 'ready' ||
        current.checkoutSessionId !== sessionId || current.tenantId !== intent.tenantId ||
        current.planId !== intent.planId)
      return audit(tx, 'rejected', 'intent_not_ready', intent.id);
    const plan = await tx.billingPlan.findUnique({
      where: { id: current.planId },
      select: { id: true, active: true, stripePriceId: true },
    });
    if (!plan?.active || plan.stripePriceId !== current.stripePriceId)
      return audit(tx, 'rejected', 'binding_conflict', current.id);

    let session;
    let subscription;
    try {
      session = stripeTestCheckoutSessionSnapshot(await provider.retrieveSession(sessionId));
      if (!session)
        return audit(tx, 'rejected', 'invalid_provider_snapshot', current.id);
      if (session.id !== sessionId || session.reference !== current.id ||
          session.expiresAt.getTime() !==
            Math.floor(current.expiresAt.getTime() / 1000) * 1000 ||
          session.created.getTime() < current.createdAt.getTime() - 300000 ||
          session.created >= session.expiresAt)
        return audit(tx, 'rejected', 'session_mismatch', current.id);
      if (!session.paid)
        return audit(tx, 'rejected', 'payment_not_verified', current.id);

      subscription = stripeTestSubscriptionSnapshot(
        await provider.retrieveSubscription(session.subscription),
      );
    } catch {
      return audit(tx, 'deferred', 'provider_unavailable', current.id);
    }
    if (!subscription)
      return audit(tx, 'rejected', 'invalid_provider_snapshot', current.id);
    if (subscription.id !== session.subscription ||
        subscription.customer !== session.customer ||
        subscription.price !== current.stripePriceId)
      return audit(tx, 'rejected', 'subscription_mismatch', current.id);
    if (subscription.status !== 'active' || subscription.trialEnd !== null ||
        subscription.periodEnd <= new Date())
      return audit(tx, 'rejected', 'payment_not_verified', current.id);

    // In particular, never silently move a customer/subscription between
    // tenants or attach a new Checkout to a legacy pre-linked subscription.
    const collisions = await tx.tenantSubscription.findMany({
      where: { OR: [
        { tenantId: current.tenantId },
        { providerSubscriptionId: subscription.id },
        { providerCustomerId: subscription.customer },
        { checkoutSessionId: session.id },
      ] },
      select: {
        id: true, tenantId: true, planId: true, provider: true,
        providerCustomerId: true, providerSubscriptionId: true,
        checkoutSessionId: true,
      },
      take: 5,
    });
    if (collisions.length) {
      const linked = collisions[0]!;
      const replay = collisions.length === 1 && linked.tenantId === current.tenantId &&
        linked.planId === current.planId &&
        linked.provider === 'stripe' &&
        linked.providerCustomerId === session.customer &&
        linked.providerSubscriptionId === session.subscription &&
        linked.checkoutSessionId === session.id;
      return audit(tx, replay ? 'replayed' : 'rejected',
        replay ? 'already_linked' : 'binding_conflict',
        current.id, replay ? current.tenantId : undefined);
    }

    // Explicit parameterized SQL avoids broad Prisma INSERT ... RETURNING
    // privileges. No default/current billing status implies an entitlement.
    await tx.$executeRaw`
      INSERT INTO subscriptions
        (id,tenant_id,plan_id,provider,provider_customer_id,
         provider_subscription_id,checkout_session_id,status,
         current_period_start,current_period_end,cancel_at_period_end,trial_end)
      VALUES (${randomUUID()}::uuid,${current.tenantId}::uuid,${current.planId}::uuid,
        'stripe',${session.customer},${subscription.id},${session.id},
        ${subscription.status},${subscription.periodStart},${subscription.periodEnd},
        ${subscription.cancelAtPeriodEnd},${subscription.trialEnd})`;
    return audit(tx, 'linked', 'provider_verified', current.id, current.tenantId);
  }, { timeout: 20000 });
}
