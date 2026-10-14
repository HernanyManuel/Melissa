import { createHash } from 'node:crypto';
import { readBoundedStripeList } from './stripe-test-cursor-pagination';
import {
  StripeTestInvoiceReader,
  stripeTestPaidInvoiceSnapshot,
} from './stripe-test-invoice-reader';

export interface StripeInvoiceReviewProvider {
  retrieveInvoice(id: string): Promise<unknown>;
  retrieveSubscription(id: string): Promise<unknown>;
  listCreditNotes(id: string): Promise<unknown>;
}
export interface StripeInvoiceReviewSnapshot {
  priceId: string;
  periodStart: Date;
  periodEnd: Date;
  issuedCreditMinor: bigint;
  creditNoteCount: number;
  digest: string;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function seconds(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1000000000 &&
    value < 253402300800
    ? value
    : null;
}
const ID = /^price_[A-Za-z0-9_-]{1,249}$/;
const NOTE = /^cn_[A-Za-z0-9_]{1,250}$/;

export type ReviewParseResult =
  | { outcome: 'valid'; snapshot: StripeInvoiceReviewSnapshot }
  | { outcome: 'invalid_period' | 'invalid_credit_notes' | 'incomplete_credits' };

// This is only an observable accounting REVIEW. It never establishes
// bank settlement/refund finality, commercial service periods, or entitlements.
// Stripe invoice.period_* describes invoice-item lookback; the service
// period comes from exactly one subscription LINE and is not a tariff period.
// prettier-ignore
export function parseStripeTestInvoiceReview(
  invoiceValue: unknown,
  noteListValue: unknown,
  expected: { invoiceId: string; customerId: string; subscriptionId: string;
    priceId: string; currency: string; amountPaidMinor: bigint; paidAt: Date },
): ReviewParseResult {
  const paid=stripeTestPaidInvoiceSnapshot(invoiceValue);
  if (!paid || paid.id!==expected.invoiceId ||
      paid.customer!==expected.customerId ||
      paid.subscription!==expected.subscriptionId ||
      paid.currency!==expected.currency ||
      paid.amountPaidMinor!==expected.amountPaidMinor ||
      paid.paidAt.getTime()!==expected.paidAt.getTime())
    return {outcome:'invalid_period'};
  const invoice=obj(invoiceValue);
  const lines=obj(invoice?.lines);
  if (lines?.object!=='list' || lines.has_more!==false ||
      !Array.isArray(lines.data) || lines.data.length!==1)
    return {outcome:'invalid_period'};
  const line=obj(lines.data[0]);
  const parent=obj(line?.parent);
  const details=obj(parent?.subscription_item_details);
  const pricing=obj(line?.pricing);
  const price=obj(pricing?.price_details);
  const period=obj(line?.period);
  const start=seconds(period?.start), end=seconds(period?.end);
  if (line?.object!=='line_item' || line.livemode!==false ||
      parent?.type!=='subscription_item_details' ||
      details?.subscription!==expected.subscriptionId ||
      pricing?.type!=='price_details' ||
      typeof price?.price!=='string' || !ID.test(price.price) ||
      price.price!==expected.priceId ||
      start===null || end===null || end<=start)
    return {outcome:'invalid_period'};

  const list=obj(noteListValue);
  if (list?.object!=='list' || !Array.isArray(list.data) ||
      list.data.length>100 || typeof list.has_more!=='boolean')
    return {outcome:'invalid_credit_notes'};
  if (list.has_more) return {outcome:'incomplete_credits'};
  const ids=new Set<string>();
  const notes: Array<{id:string;status:string;amount:number}>=[];
  let total=0n, count=0;
  for (const item of list.data) {
    const n=obj(item);
    if (!n || n.object!=='credit_note' || n.livemode!==false ||
        typeof n.id!=='string' || !NOTE.test(n.id) || ids.has(n.id) ||
        n.invoice!==expected.invoiceId || n.customer!==expected.customerId ||
        n.currency!==expected.currency.toLowerCase() ||
        (n.status!=='issued' && n.status!=='void') ||
        typeof n.amount!=='number' || !Number.isSafeInteger(n.amount) ||
        n.amount<0 || n.amount>100000000000)
      return {outcome:'invalid_credit_notes'};
    ids.add(n.id);
    notes.push({id:n.id,status:n.status,amount:n.amount});
    if (n.status==='issued') { total+=BigInt(n.amount);count++; }
  }
  // Mixed credits, prepayment credits and overpayments need a separately
  // reviewed finance policy; do not misrepresent a net amount as settled.
  if (total>expected.amountPaidMinor)
    return {outcome:'invalid_credit_notes'};
  notes.sort((a,b)=>a.id.localeCompare(b.id));
  const digest=createHash('sha256').update(JSON.stringify({
    invoiceId:paid.id,customer:paid.customer,subscription:paid.subscription,
    currency:paid.currency,amountPaidMinor:paid.amountPaidMinor.toString(),
    paidAt:paid.paidAt.toISOString(),priceId:price.price,
    start,end,notes,
  })).digest('hex');
  return {
    outcome:'valid',
    snapshot:{
      priceId:price.price,
      periodStart:new Date(start*1000),
      periodEnd:new Date(end*1000),
      issuedCreditMinor:total,creditNoteCount:count,digest,
    },
  };
}

// Reuse the ADR-115 bounded HTTP client and test credentials.
export class StripeTestInvoiceReviewReader
  extends StripeTestInvoiceReader
  implements StripeInvoiceReviewProvider
{
  async listCreditNotes(invoiceId: string): Promise<unknown> {
    if (!/^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId))
      throw new Error('Invalid Stripe test invoice ID');
    return readBoundedStripeList((cursor) =>
      this.readTestResource(
        '/v1/credit_notes?invoice=' +
          invoiceId +
          '&limit=100' +
          (cursor ? '&starting_after=' + cursor : ''),
      ),
    );
  }
}
