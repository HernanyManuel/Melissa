import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { linkStoredStripeTestCheckout } from '../src/billing/stripe-checkout-linker';
import { StripeTestCheckoutSessionReader } from '../src/billing/stripe-test-checkout-session-reader';
import { StripeTestSubscriptionReader } from '../src/billing/stripe-test-subscription-reader';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.STRIPE_TEST_LINK_ENABLED !== 'true')
    throw new Error('Stripe Checkout linking is disabled outside explicit test mode');
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  const url = process.env.BILLING_LINKER_DATABASE_URL;
  const id = process.argv[2];
  if (!url || !key || !id || process.argv.length !== 3)
    throw new Error('Dedicated linker database URL, test secret and stored event ID required');
  const checkout = new StripeTestCheckoutSessionReader(key);
  const subscription = new StripeTestSubscriptionReader(key);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const result = await linkStoredStripeTestCheckout(db, id, {
      retrieveSession: (sessionId) => checkout.retrieveSession(sessionId),
      retrieveSubscription: (subscriptionId) => subscription.retrieve(subscriptionId),
    });
    process.stdout.write(JSON.stringify({ eventId: id, ...result }) + '\n');
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  // Fail safely without revealing credentials or provider payloads.
  process.stderr.write('Stripe test Checkout association failed\n');
  process.exitCode = 1;
});
