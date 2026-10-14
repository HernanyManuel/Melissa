import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { StripeCheckoutLinkProvider } from './stripe-test-checkout-session-reader';
import { StripeSubscriptionReader, reconcileStoredStripeTestEvent } from './stripe-reconciler';
import { linkStoredStripeTestCheckout } from './stripe-checkout-linker';

export interface StripeTestDispatchConnections {
  dispatcher: PrismaClient;
  linker: PrismaClient;
  reconciler: PrismaClient;
}
export interface StripeTestDispatchProviders {
  checkout: StripeCheckoutLinkProvider;
  subscription: StripeSubscriptionReader;
}
export interface StripeTestDispatchResult {
  eventId: string;
  attempt: number;
  action: 'complete' | 'retry' | 'dead';
  reason: string;
}
interface Claimed {
  eventId: string;
  eventType: string;
  attempts: number;
  leaseToken: string;
}

const EVENT = /^evt_[A-Za-z0-9_]{1,251}$/;
const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 6;

// Bounded exponential retry: 30s, 120s, 480s, 1800s, 1800s.
// Never use webhook metadata, network response, or client input as tenant ID.
export function dispatchRetrySeconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS)
    throw new Error('Invalid dispatch attempt number');
  return Math.min(1800, 30 * 4 ** (attempt - 1));
}

async function assertDispatcherRole(db: PrismaClient): Promise<void> {
  const [role] = await db.$queryRaw<Array<{ safe: boolean }>>`
    SELECT current_user='melissa_billing_dispatcher' AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AS safe
    FROM pg_roles WHERE rolname=current_user`;
  if (role?.safe !== true) throw new Error('Dedicated Stripe dispatcher role required');
}

// A single UPDATE with SKIP LOCKED atomically claims one due job. Expired
// leases can be reclaimed after crashes; fencing token protects late runners.
// prettier-ignore
export async function claimStripeTestEvent(
  db: PrismaClient, onlyEventId?: string,
): Promise<Claimed | null> {
  if (onlyEventId && !EVENT.test(onlyEventId))
    throw new Error('Invalid Stripe event ID');
  await assertDispatcherRole(db);
  const token = randomUUID();
  const [row] = await db.$transaction(async (tx) => {
    const selected = await tx.$queryRaw<Array<Claimed>>`
      WITH due AS (
        SELECT event_id FROM stripe_event_dispatch
        WHERE attempts < ${MAX_ATTEMPTS} AND
          (${onlyEventId ?? null}::text IS NULL OR event_id=${onlyEventId ?? null})
          AND (
            (state='pending' AND next_attempt_at<=CURRENT_TIMESTAMP)
            OR (state='leased' AND lease_until<=CURRENT_TIMESTAMP)
          )
        ORDER BY next_attempt_at,event_id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE stripe_event_dispatch AS q
      SET state='leased', attempts=q.attempts+1,
          lease_token=${token}::uuid,
          lease_until=CURRENT_TIMESTAMP + INTERVAL '90 seconds',
          updated_at=CURRENT_TIMESTAMP,
          last_reason=CASE WHEN q.state='leased' THEN 'lease_expired' ELSE q.last_reason END
      FROM due WHERE q.event_id=due.event_id
      RETURNING q.event_id AS "eventId",q.event_type AS "eventType",
                q.attempts,q.lease_token AS "leaseToken"`;
    if (selected.length) {
      await tx.$executeRaw`
        INSERT INTO stripe_dispatch_attempts
          (id,event_id,attempt,action,reason)
        VALUES (${randomUUID()}::uuid,${selected[0]!.eventId},
          ${selected[0]!.attempts},'claimed','claimed')`;
    }
    return selected;
  }, { timeout: 10000 });
  return row ?? null;
}

type Decision = { action: 'complete' | 'retry'; reason: string };

// Only provider read/association behind respective restricted roles. The
// dispatcher connection can NEVER see Stripe payload, subscriptions or plans.
async function handleEvent(
  job: Claimed,
  connections: StripeTestDispatchConnections,
  providers: StripeTestDispatchProviders,
): Promise<Decision> {
  if (job.eventType === 'checkout.session.completed') {
    const result = await linkStoredStripeTestCheckout(
      connections.linker, job.eventId, providers.checkout,
    );
    if (result.outcome === 'linked' || result.outcome === 'replayed')
      return { action: 'complete', reason: result.outcome };
    if (result.outcome === 'deferred' || result.reason === 'unknown_checkout' ||
        result.reason === 'intent_not_ready')
      return { action: 'retry', reason: result.outcome === 'deferred'
        ? 'provider_unavailable' : 'unmapped' };
    return { action: 'complete', reason: 'rejected' };
  }
  const result = await reconcileStoredStripeTestEvent(
    connections.reconciler, job.eventId, providers.subscription,
  );
  if (result.outcome === 'applied' || result.outcome === 'skipped')
    return { action: 'complete', reason: result.outcome };
  if (result.outcome === 'unmapped' || result.outcome === 'deferred')
    return { action: 'retry', reason: result.outcome === 'unmapped'
      ? 'unmapped' : 'provider_unavailable' };
  return { action: 'complete', reason: 'rejected' };
}

// Retry states keep the same signed event and original immutable provider
// references. No client-authored body, tenant metadata or entitlement writes.
// prettier-ignore
export async function dispatchOneStripeTestEvent(
  connections: StripeTestDispatchConnections,
  providers: StripeTestDispatchProviders,
  onlyEventId?: string,
): Promise<StripeTestDispatchResult | null> {
  const job = await claimStripeTestEvent(connections.dispatcher, onlyEventId);
  if (!job) return null;
  let decision: Decision;
  try {
    decision = await handleEvent(job, connections, providers);
  } catch {
    decision = { action: 'retry', reason: 'handler_error' };
  }
  const action = decision.action === 'retry' && job.attempts >= MAX_ATTEMPTS
    ? 'dead' : decision.action;
  const reason = decision.reason;
  const delay = action === 'retry' ? dispatchRetrySeconds(job.attempts) : 0;

  const updated = await connections.dispatcher.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE stripe_event_dispatch
      SET state=${action === 'complete' ? 'complete' : action === 'dead' ? 'dead' : 'pending'},
          lease_token=NULL,lease_until=NULL,
          next_attempt_at=CURRENT_TIMESTAMP + ${delay} * INTERVAL '1 second',
          last_reason=${reason},updated_at=CURRENT_TIMESTAMP
      WHERE event_id=${job.eventId}
        AND state='leased' AND lease_token=${job.leaseToken}::uuid
        AND attempts=${job.attempts}
        AND lease_until>CURRENT_TIMESTAMP`;
    if (changed === 1) {
      await tx.$executeRaw`
        INSERT INTO stripe_dispatch_attempts
          (id,event_id,attempt,action,reason)
        VALUES (${randomUUID()}::uuid,${job.eventId},${job.attempts},
          ${action},${reason})`;
    }
    return changed;
  }, { timeout: 10000 });
  // An expired/stolen lease cannot publish a stale decision or audit.
  if (updated !== 1) throw new Error('Stripe dispatch lease lost');
  return { eventId: job.eventId, attempt: job.attempts, action, reason };
}
