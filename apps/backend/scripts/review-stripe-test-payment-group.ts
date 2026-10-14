import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { reviewStripeTestPaymentGroup } from '../src/billing/stripe-payment-group-verifier';
import { StripeTestPaymentRiskReader } from '../src/billing/stripe-test-payment-risk';

// Operator-only, TEST-only observation of multiple linked payments. It does
// not reconcile refunds across charges or enable financial clearance.
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.STRIPE_TEST_PAYMENT_GROUP_ENABLED !== 'true')
    throw new Error('Multi-payment observation disabled outside TEST mode');
  const url = process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  const invoiceId = process.argv[2];
  if (!url || !key || !invoiceId || process.argv.length !== 3)
    throw new Error('TEST credentials, restricted verifier URL, invoice ID required');
  const provider = new StripeTestPaymentRiskReader(key);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const result = await reviewStripeTestPaymentGroup(db, invoiceId, provider);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  process.stderr.write('Stripe TEST multi-payment observation failed\n');
  process.exitCode = 1;
});
