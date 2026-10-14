import { createHash } from 'node:crypto';
import { readBoundedStripeList } from './stripe-test-cursor-pagination';
import {
  StripeTestInvoiceReader,
  stripeTestPaidInvoiceSnapshot,
} from './stripe-test-invoice-reader';

export interface StripePaymentRiskProvider {
  retrieveInvoice(id: string): Promise<unknown>;
  listInvoicePayments(id: string): Promise<unknown>;
  retrievePaymentIntent(id: string): Promise<unknown>;
  retrieveCharge(id: string): Promise<unknown>;
  listRefunds(chargeId: string): Promise<unknown>;
  listDisputes(chargeId: string): Promise<unknown>;
}
export interface RiskEvidence {
  paymentIntentId: string;
  chargeId: string;
  snapshotSha256: string;
  refundCount: number;
  succeededRefundMinor: bigint;
  pendingRefundMinor: bigint;
  disputeCount: number;
  unresolvedDisputeCount: number;
}
export type RiskParse =
  | { outcome: 'valid'; snapshot: RiskEvidence }
  | {
      outcome:
        | 'invoice_mismatch'
        | 'payment_mapping_invalid'
        | 'payment_mapping_incomplete'
        | 'charge_mismatch'
        | 'invalid_refund_list'
        | 'invalid_dispute_list'
        | 'incomplete_risk_data';
    };
export interface ExpectedRiskInvoice {
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  currency: string;
  amountPaidMinor: bigint;
  paidAt: Date;
}
const PI = /^pi_[A-Za-z0-9_]{1,250}$/;
const CH = /^ch_[A-Za-z0-9_]{1,250}$/;
const RE = /^re_[A-Za-z0-9_]{1,250}$/;
const DU = /^dp_[A-Za-z0-9_]{1,250}$|^du_[A-Za-z0-9_]{1,250}$/;
const REFUND_STATUSES = ['succeeded', 'pending', 'requires_action', 'failed', 'canceled'];
const DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
];
function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function money(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000_000
    ? v
    : null;
}
function list(v: unknown): { data: unknown[]; hasMore: boolean } | null {
  const x = obj(v);
  if (
    x?.object !== 'list' ||
    !Array.isArray(x.data) ||
    x.data.length > 100 ||
    typeof x.has_more !== 'boolean'
  )
    return null;
  return { data: x.data, hasMore: x.has_more };
}

// Refuse inferred payment ownership. The only accepted chain is one settled
// Stripe InvoicePayment -> succeeded PI -> captured, paid Charge for the
// same tenant-bound customer, currency, invoice and amount.
// prettier-ignore
export function parseStripeTestPaymentRisk(
  invoiceRaw:unknown,paymentsRaw:unknown,piRaw:unknown,chargeRaw:unknown,
  refundsRaw:unknown,disputesRaw:unknown,expected:ExpectedRiskInvoice,
):RiskParse {
  const invoice=stripeTestPaidInvoiceSnapshot(invoiceRaw);
  if(!invoice||invoice.id!==expected.invoiceId||
     invoice.customer!==expected.customerId||
     invoice.subscription!==expected.subscriptionId||
     invoice.currency!==expected.currency||
     invoice.amountPaidMinor!==expected.amountPaidMinor||
     invoice.paidAt.getTime()!==expected.paidAt.getTime())
    return {outcome:'invoice_mismatch'};
  const payments=list(paymentsRaw);
  if(!payments) return {outcome:'payment_mapping_invalid'};
  if(payments.hasMore) return {outcome:'payment_mapping_incomplete'};
  if(payments.data.length!==1) return {outcome:'payment_mapping_invalid'};
  const payment=obj(payments.data[0]),link=obj(payment?.payment);
  const piId=link?.payment_intent;
  if(payment?.object!=='invoice_payment'||payment.livemode!==false||
     payment.invoice!==expected.invoiceId||payment.status!=='paid'||
     payment.currency!==expected.currency.toLowerCase()||
     money(payment.amount_paid)===null||
     BigInt(payment.amount_paid as number)!==expected.amountPaidMinor||
     link?.type!=='payment_intent'||typeof piId!=='string'||!PI.test(piId))
    return {outcome:'payment_mapping_invalid'};
  const pi=obj(piRaw);
  const chargeId=pi?.latest_charge;
  if(!pi||pi.object!=='payment_intent'||pi.livemode!==false||
     pi.id!==piId||pi.status!=='succeeded'||
     pi.customer!==expected.customerId||
     pi.currency!==expected.currency.toLowerCase()||
     money(pi.amount_received)===null||
     BigInt(pi.amount_received as number)<expected.amountPaidMinor||
     typeof chargeId!=='string'||!CH.test(chargeId))
    return {outcome:'charge_mismatch'};
  const charge=obj(chargeRaw);
  if(!charge||charge.object!=='charge'||charge.livemode!==false||
     charge.id!==chargeId||charge.payment_intent!==piId||
     charge.customer!==expected.customerId||
     charge.currency!==expected.currency.toLowerCase()||
     charge.status!=='succeeded'||charge.paid!==true||charge.captured!==true||
     money(charge.amount)===null||
     BigInt(charge.amount as number)<expected.amountPaidMinor)
    return {outcome:'charge_mismatch'};
  const refundList=list(refundsRaw), disputeList=list(disputesRaw);
  if(!refundList) return {outcome:'invalid_refund_list'};
  if(!disputeList) return {outcome:'invalid_dispute_list'};
  if(refundList.hasMore||disputeList.hasMore)
    return {outcome:'incomplete_risk_data'};
  const refunds: Array<{id:string;status:string;amount:number}>=[];
  const refundIds=new Set<string>();
  let succeeded=0n,pending=0n;
  for(const item of refundList.data){
    const r=obj(item),id=r?.id;
    const amount=money(r?.amount);
    if(!r||r.object!=='refund'||r.livemode!==false||
       typeof id!=='string'||!RE.test(id)||refundIds.has(id)||
       r.charge!==chargeId||r.payment_intent!==piId||
       r.currency!==expected.currency.toLowerCase()||
       typeof r.status!=='string'||!REFUND_STATUSES.includes(r.status)||
       amount===null||amount===0) return {outcome:'invalid_refund_list'};
    refundIds.add(id);refunds.push({id,status:r.status,amount});
    if(r.status==='succeeded') succeeded+=BigInt(amount);
    if(r.status==='pending'||r.status==='requires_action') pending+=BigInt(amount);
  }
  if(succeeded>expected.amountPaidMinor||pending>expected.amountPaidMinor||
     succeeded+pending>expected.amountPaidMinor)
    return {outcome:'invalid_refund_list'};
  const disputes:Array<{id:string;status:string;amount:number}>=[];
  const disputeIds=new Set<string>();
  let unresolved=0;
  for(const item of disputeList.data){
    const d=obj(item),id=d?.id;
    const amount=money(d?.amount);
    if(!d||d.object!=='dispute'||d.livemode!==false||
       typeof id!=='string'||!DU.test(id)||disputeIds.has(id)||
       d.charge!==chargeId||d.payment_intent!==piId||
       d.currency!==expected.currency.toLowerCase()||
       typeof d.status!=='string'||!DISPUTE_STATUSES.includes(d.status)||
       amount===null||amount===0||BigInt(amount)>expected.amountPaidMinor)
      return {outcome:'invalid_dispute_list'};
    disputeIds.add(id);disputes.push({id,status:d.status,amount});
    if(!['won','lost','warning_closed'].includes(d.status)) unresolved++;
  }
  refunds.sort((a,b)=>a.id.localeCompare(b.id));
  disputes.sort((a,b)=>a.id.localeCompare(b.id));
  const digest=createHash('sha256').update(JSON.stringify({
    invoiceId:expected.invoiceId,customerId:expected.customerId,
    currency:expected.currency,amountPaidMinor:expected.amountPaidMinor.toString(),
    piId,chargeId,refunds,disputes,
  })).digest('hex');
  return {outcome:'valid',snapshot:{
    paymentIntentId:piId,chargeId,snapshotSha256:digest,
    refundCount:refunds.length,succeededRefundMinor:succeeded,
    pendingRefundMinor:pending,disputeCount:disputes.length,
    unresolvedDisputeCount:unresolved,
  }};
}

export class StripeTestPaymentRiskReader
  extends StripeTestInvoiceReader
  implements StripePaymentRiskProvider
{
  async listInvoicePayments(id: string): Promise<unknown> {
    if (!/^in_[A-Za-z0-9_]{1,250}$/.test(id)) throw new Error('Invalid invoice ID');
    return readBoundedStripeList((cursor) => this.readTestResource('/v1/invoice_payments?invoice=' + id + '&limit=100' + (cursor ? '&starting_after=' + cursor : '')));
  }
  async retrievePaymentIntent(id: string): Promise<unknown> {
    if (!PI.test(id)) throw new Error('Invalid PaymentIntent ID');
    return this.readTestResource('/v1/payment_intents/' + id);
  }
  async retrieveCharge(id: string): Promise<unknown> {
    if (!CH.test(id)) throw new Error('Invalid Charge ID');
    return this.readTestResource('/v1/charges/' + id);
  }
  async listRefunds(id: string): Promise<unknown> {
    if (!CH.test(id)) throw new Error('Invalid Charge ID');
    return readBoundedStripeList((cursor) => this.readTestResource('/v1/refunds?charge=' + id + '&limit=100' + (cursor ? '&starting_after=' + cursor : '')));
  }
  async listDisputes(id: string): Promise<unknown> {
    if (!CH.test(id)) throw new Error('Invalid Charge ID');
    return readBoundedStripeList((cursor) => this.readTestResource('/v1/disputes?charge=' + id + '&limit=100' + (cursor ? '&starting_after=' + cursor : '')));
  }
}
