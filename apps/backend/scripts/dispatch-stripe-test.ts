import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { dispatchOneStripeTestEvent } from '../src/billing/stripe-test-dispatcher';
import { StripeTestCheckoutSessionReader } from '../src/billing/stripe-test-checkout-session-reader';
import { StripeTestSubscriptionReader } from '../src/billing/stripe-test-subscription-reader';

// Operator-scheduled ONE bounded batch per process; no production daemon.
// Explicit test-only opt-in, independent least-privileged DB credentials.
// prettier-ignore
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' ||
      process.env.STRIPE_TEST_DISPATCH_ENABLED !== 'true' ||
      process.env.STRIPE_TEST_LINK_ENABLED !== 'true' ||
      process.env.STRIPE_TEST_RECONCILE_ENABLED !== 'true')
    throw new Error('Stripe test dispatcher is disabled');
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  const dispatcherUrl = process.env.BILLING_DISPATCHER_DATABASE_URL;
  const linkerUrl = process.env.BILLING_LINKER_DATABASE_URL;
  const reconcilerUrl = process.env.BILLING_RECONCILER_DATABASE_URL;
  const sizeArg = process.argv[2] ?? '1';
  if (!key || !dispatcherUrl || !linkerUrl || !reconcilerUrl ||
      !/^([1-9]|1[0-9]|20)$/.test(sizeArg) || process.argv.length > 3)
    throw new Error('Test key, three restricted database URLs and batch size 1..20 required');

  const checkout = new StripeTestCheckoutSessionReader(key);
  const subscription = new StripeTestSubscriptionReader(key);
  const dispatcher = new PrismaClient({ datasources: { db: { url: dispatcherUrl } } });
  const linker = new PrismaClient({ datasources: { db: { url: linkerUrl } } });
  const reconciler = new PrismaClient({ datasources: { db: { url: reconcilerUrl } } });
  try {
    let claimed = 0;
    let retried = 0;
    let dead = 0;
    for (let i = 0; i < Number(sizeArg); i++) {
      const result = await dispatchOneStripeTestEvent(
        { dispatcher, linker, reconciler },
        {
          checkout: {
            retrieveSession: (id) => checkout.retrieveSession(id),
            retrieveSubscription: (id) => subscription.retrieve(id),
          },
          subscription,
        },
      );
      if (!result) break;
      claimed++;
      if (result.action === 'retry') retried++;
      if (result.action === 'dead') dead++;
    }
    // Never print Stripe provider IDs, body, tenant IDs or secrets.
    process.stdout.write(JSON.stringify({ claimed, retried, dead }) + '\n');
  } finally {
    await Promise.all([dispatcher.$disconnect(),linker.$disconnect(),reconciler.$disconnect()]);
  }
}

void main().catch(() => {
  process.stderr.write('Stripe test dispatch failed\n');
  process.exitCode = 1;
});
