import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { reviewStoredStripeTestInvoice } from '../src/billing/stripe-invoice-review-verifier';
import { StripeTestInvoiceReviewReader } from '../src/billing/stripe-test-invoice-review';

// Deliberately one operator-selected TEST invoice per invocation, never a
// production daemon. Reuses the independent NOLOGIN-by-default verifier role.
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' ||
      process.env.STRIPE_TEST_INVOICE_REVIEW_ENABLED !== 'true')
    throw new Error('Invoice review is disabled outside explicit test mode');
  const key=process.env.STRIPE_TEST_SECRET_KEY;
  const url=process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const id=process.argv[2];
  if (!key || !url || !id || process.argv.length!==3)
    throw new Error('Test credentials, dedicated DB URL, and invoice ID required');
  const provider=new StripeTestInvoiceReviewReader(key);
  const db=new PrismaClient({datasources:{db:{url}}});
  try {
    const result=await reviewStoredStripeTestInvoice(db,id,provider);
    process.stdout.write(JSON.stringify({outcome:result.outcome,reason:result.reason})+'\n');
  } finally {
    await db.$disconnect();
  }
}
void main().catch(()=>{
  process.stderr.write('Stripe test invoice review failed\n');
  process.exitCode=1;
});
