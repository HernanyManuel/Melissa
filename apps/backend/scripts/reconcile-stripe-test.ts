import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { reconcileStoredStripeTestEvent } from '../src/billing/stripe-reconciler';
import { StripeTestSubscriptionReader } from '../src/billing/stripe-test-subscription-reader';

// prettier-ignore
async function main(): Promise<void> {
  // This is a deliberate *offline* test-only operator command, not a
  // scheduled worker and never a public API or production payment path.
  if (process.env.NODE_ENV !== 'test' ||
      process.env.STRIPE_TEST_RECONCILE_ENABLED !== 'true')
    throw new Error('Stripe reconciliation is disabled outside explicit test mode');
  const url = process.env.STRIPE_TEST_RECONCILE_DATABASE_URL;
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  const id = process.argv[2];
  if (!url || !key || !id || process.argv.length !== 3)
    throw new Error('Restricted test database, Stripe test secret, and event ID are required');
  // A migration/owner credential has unrestricted writes and MUST NOT be
  // accepted by this operator command, even in a test environment.
  let username: string;
  try {
    username = new URL(url).username;
  } catch {
    throw new Error('Invalid restricted Stripe reconciliation database URL');
  }
  if (username !== 'melissa_stripe_reconciler')
    throw new Error('Dedicated Stripe reconciliation role required');
  const provider = new StripeTestSubscriptionReader(key);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const result = await reconcileStoredStripeTestEvent(db, id, provider);
    // No provider payload, customer ID, tenant name or secrets in output.
    process.stdout.write(JSON.stringify({ eventId: id, ...result }) + '\n');
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write('Stripe test reconciliation failed\n');
  process.exitCode = 1;
});
