import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import {
  reviewStripeTestAutomaticPayout,
  StripeTestPayoutVerifierReader,
} from '../src/billing/stripe-test-payout-verifier';

// prettier-ignore
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.STRIPE_TEST_PAYOUT_ENABLED !== 'true')
    throw new Error('Stripe TEST payout observations disabled');
  const key=process.env.STRIPE_TEST_SECRET_KEY;
  const url=process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const [invoiceId,payoutId]=process.argv.slice(2);
  if(!key || !url || !invoiceId || !payoutId || process.argv.length!==4)
    throw new Error('Dedicated TEST credentials, invoice and payout ID required');
  const provider=new StripeTestPayoutVerifierReader(key);
  const db=new PrismaClient({datasources:{db:{url}}});
  try {
    const result=await reviewStripeTestAutomaticPayout(db,invoiceId,payoutId,provider);
    process.stdout.write(JSON.stringify(result)+'\n');
  } finally { await db.$disconnect(); }
}
// prettier-ignore
void main().catch(()=>{
  process.stderr.write('Stripe TEST payout review failed\n');
  process.exitCode=1;
});
