import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import {
  reviewStripeTestGroupChargeRisk,
  StripeTestGroupChargeRiskReader,
} from '../src/billing/stripe-group-charge-risk-verifier';

// Operator-only Stripe TEST read workflow, never a payment/entitlement daemon.
async function main():Promise<void>{
  if(process.env.NODE_ENV!=='test'||
     process.env.STRIPE_TEST_GROUP_RISK_ENABLED!=='true')
    throw new Error('Stripe TEST group risk verification disabled');
  const key=process.env.STRIPE_TEST_SECRET_KEY;
  const url=process.env.BILLING_INVOICE_VERIFIER_DATABASE_URL;
  const invoiceId=process.argv[2];
  if(!key||!url||!invoiceId||process.argv.length!==3)
    throw new Error('Dedicated verifier URL, test key and invoice ID required');
  const provider=new StripeTestGroupChargeRiskReader(key);
  const db=new PrismaClient({datasources:{db:{url}}});
  try{
    const result=await reviewStripeTestGroupChargeRisk(db,invoiceId,provider);
    process.stdout.write(JSON.stringify(result)+'\n');
  }finally{await db.$disconnect();}
}
void main().catch(()=>{
  process.stderr.write('TEST group charge risk review failed\n');
  process.exitCode=1;
});
