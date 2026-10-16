import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import {
  reviewStripeTestGroupBalances,StripeTestGroupBalanceReader,
} from '../src/billing/stripe-group-balance-verifier';

// A deliberately manual TEST-only one-invoice snapshot, not a settlement job.
async function main():Promise<void>{
  if(process.env.NODE_ENV!=='test'||
     process.env.STRIPE_TEST_GROUP_BALANCE_ENABLED!=='true')
    throw new Error('Stripe TEST balance observation disabled');
  const key=process.env.STRIPE_TEST_SECRET_KEY;
  const url=process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const invoiceId=process.argv[2];
  if(!key||!url||!invoiceId||process.argv.length!==3)
    throw new Error('Dedicated verifier URL, TEST key, invoice ID required');
  const provider=new StripeTestGroupBalanceReader(key);
  const db=new PrismaClient({datasources:{db:{url}}});
  try{
    const result=await reviewStripeTestGroupBalances(db,invoiceId,provider);
    process.stdout.write(JSON.stringify(result)+'\n');
  }finally{await db.$disconnect();}
}
void main().catch(()=>{
  process.stderr.write('Stripe TEST balance review failed\n');
  process.exitCode=1;
});
