import { createHash } from 'node:crypto';
import { stripeTestPaidInvoiceSnapshot } from './stripe-test-invoice-reader';

export interface GroupExpected {
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  currency: string;
  amountPaidMinor: bigint;
  paidAt: Date;
}
export interface PaymentGroupLink {
  paymentIntent: unknown;
  charge: unknown;
}
export type PaymentGroupParse =
  | { outcome: 'valid'; snapshot: {
      digest: string;
      count: number;
      paidMinor: bigint;
    } }
  | { outcome:
      'invoice_mismatch' | 'partial_list' |
      'unsupported_payment_count' | 'invalid_payment_graph' };

const ID=/^inpay_[A-Za-z0-9_]{1,248}$/;
const PI=/^pi_[A-Za-z0-9_]{1,250}$/;
const CH=/^ch_[A-Za-z0-9_]{1,250}$/;
function obj(x:unknown):Record<string,unknown>|null{
  return x!==null&&typeof x==='object'&&!Array.isArray(x)
    ? x as Record<string,unknown>:null;
}
function minor(x:unknown):number|null {
  return typeof x==='number'&&Number.isSafeInteger(x)&&x>0&&x<=100_000_000_000
    ? x:null;
}

// A multi-PI invoice is only observed when all 2..8 allocations belong
// exclusively to the SAME pre-linked Stripe TEST invoice/customer. Fail
// closed on split PI funding or partial invoice allocation. Refund/dispute
// clearing is explicitly OUT OF SCOPE for this payment-group ledger.
// prettier-ignore
export function parseStripeTestPaymentGroup(
  invoiceRaw:unknown,paymentsRaw:unknown,
  links:PaymentGroupLink[],expected:GroupExpected,
):PaymentGroupParse{
  const invoice=stripeTestPaidInvoiceSnapshot(invoiceRaw);
  if(!invoice||invoice.id!==expected.invoiceId||
     invoice.customer!==expected.customerId||
     invoice.subscription!==expected.subscriptionId||
     invoice.currency!==expected.currency||
     invoice.amountPaidMinor!==expected.amountPaidMinor||
     invoice.paidAt.getTime()!==expected.paidAt.getTime())
    return {outcome:'invoice_mismatch'};
  const list=obj(paymentsRaw);
  if(list?.object!=='list'||!Array.isArray(list.data)||
     list.data.length>100||typeof list.has_more!=='boolean')
    return {outcome:'invalid_payment_graph'};
  if(list.has_more) return {outcome:'partial_list'};
  if(list.data.length<2||list.data.length>8||
     links.length!==list.data.length)
    return {outcome:'unsupported_payment_count'};

  const ids=new Set<string>(),pis=new Set<string>(),charges=new Set<string>();
  const contributions:Array<{
    id:string;paymentIntentId:string;chargeId:string;minor:number;
  }>=[];
  let sum=0n;
  for(let i=0;i<list.data.length;i++){
    const payment=obj(list.data[i]),link=obj(payment?.payment);
    const pi=obj(links[i]?.paymentIntent),charge=obj(links[i]?.charge);
    const paymentId=payment?.id,piId=link?.payment_intent,chargeId=pi?.latest_charge;
    const amount=minor(payment?.amount_paid);
    if(!payment||payment.object!=='invoice_payment'||payment.livemode!==false||
       payment.status!=='paid'||payment.invoice!==expected.invoiceId||
       payment.currency!==expected.currency.toLowerCase()||
       typeof paymentId!=='string'||!ID.test(paymentId)||ids.has(paymentId)||
       link?.type!=='payment_intent'||
       typeof piId!=='string'||!PI.test(piId)||pis.has(piId)||
       amount===null||
       !pi||pi.object!=='payment_intent'||pi.livemode!==false||
       pi.id!==piId||pi.customer!==expected.customerId||
       pi.currency!==expected.currency.toLowerCase()||
       pi.status!=='succeeded'||minor(pi.amount_received)!==amount||
       typeof chargeId!=='string'||!CH.test(chargeId)||charges.has(chargeId)||
       !charge||charge.object!=='charge'||charge.livemode!==false||
       charge.id!==chargeId||charge.payment_intent!==piId||
       charge.customer!==expected.customerId||
       charge.currency!==expected.currency.toLowerCase()||
       charge.status!=='succeeded'||charge.paid!==true||
       charge.captured!==true||minor(charge.amount)!==amount)
      return {outcome:'invalid_payment_graph'};
    ids.add(paymentId);pis.add(piId);charges.add(chargeId);
    sum+=BigInt(amount);
    contributions.push({id:paymentId,paymentIntentId:piId,chargeId,minor:amount});
  }
  if(sum!==expected.amountPaidMinor)
    return {outcome:'invalid_payment_graph'};
  contributions.sort((a,b)=>a.id.localeCompare(b.id));
  const digest=createHash('sha256').update(JSON.stringify({
    invoiceId:expected.invoiceId,customer:expected.customerId,
    currency:expected.currency,paidMinor:sum.toString(),contributions,
  })).digest('hex');
  return {outcome:'valid',snapshot:{
    digest,count:contributions.length,paidMinor:sum,
  }};
}
