import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { reviewStripeTestPaymentRisk } from '../src/billing/stripe-payment-risk-verifier';
import { StripeTestPaymentRiskReader } from '../src/billing/stripe-test-payment-risk';

// One operator-reviewed TEST invoice per invocation, not a daemon.
// No refunds or disputes are created/answered by this read-only command.
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.STRIPE_TEST_PAYMENT_RISK_ENABLED !== 'true')
    throw new Error('Stripe TEST payment risk review disabled');
  const key = process.env.STRIPE_TEST_SECRET_KEY;
  const url = process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const invoiceId = process.argv[2];
  if (!key || !url || !invoiceId || process.argv.length !== 3)
    throw new Error('Test key, verifier DB URL and invoice ID required');
  const provider = new StripeTestPaymentRiskReader(key);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const result = await reviewStripeTestPaymentRisk(db, invoiceId, provider);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  process.stderr.write('Stripe TEST payment risk review failed\n');
  process.exitCode = 1;
});
