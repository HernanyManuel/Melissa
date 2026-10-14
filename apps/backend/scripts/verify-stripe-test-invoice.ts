import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { recordStoredStripeTestInvoice } from '../src/billing/stripe-invoice-evidence-verifier';
import { StripeTestInvoiceReader } from '../src/billing/stripe-test-invoice-reader';

// Explicit operator action, NEVER a production daemon or automatic entitlement.
// Separate NOLOGIN-by-default identity has no permissions in the API runtime.
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' ||
      process.env.STRIPE_TEST_INVOICE_EVIDENCE_ENABLED !== 'true')
    throw new Error('Invoice evidence verification is disabled outside test mode');
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  const url = process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const eventId = process.argv[2];
  if (!key || !url || !eventId || process.argv.length !== 3)
    throw new Error('Stripe test credentials, restricted DB URL and stored event required');
  const provider = new StripeTestInvoiceReader(key);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const result = await recordStoredStripeTestInvoice(db,eventId,provider);
    process.stdout.write(JSON.stringify({eventId,...result})+'\n');
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  process.stderr.write('Test invoice evidence verification failed\n');
  process.exitCode=1;
});
