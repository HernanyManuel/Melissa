import { createHash } from 'node:crypto';
import {
  GroupExpected,
  PaymentGroupLink,
  parseStripeTestPaymentGroup,
} from './stripe-test-payment-group';
import { parseStripeTestPaymentRisk } from './stripe-test-payment-risk';

export interface LinkedChargeRisk extends PaymentGroupLink {
  refunds: unknown;
  disputes: unknown;
}
export type GroupChargeRiskParse =
  | {
      outcome: 'valid';
      snapshot: {
        groupDigest: string;
        riskDigest: string;
        chargeCount: number;
        refundCount: number;
        succeededRefundMinor: bigint;
        pendingRefundMinor: bigint;
        disputeCount: number;
        unresolvedDisputeCount: number;
      };
    }
  | {
      outcome: 'invoice_mismatch' | 'partial_list' | 'invalid_risk_graph' | 'incomplete_risk_data';
    };

function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

// Revalidate every charge against a FULL, already validated Stripe TEST
// InvoicePayment allocation graph. A synthetic one-payment invoice is used
// internally ONLY as a strict parser fixture: it is not persisted, shown,
// or treated as a provider invoice or a commercial liability.
// prettier-ignore
export function parseStripeTestGroupChargeRisk(
  invoiceRaw:unknown,paymentsRaw:unknown,
  charges:LinkedChargeRisk[],expected:GroupExpected,
):GroupChargeRiskParse {
  const group=parseStripeTestPaymentGroup(
    invoiceRaw,paymentsRaw,charges,expected);
  if(group.outcome!=='valid')
    return {outcome:group.outcome==='partial_list'?'partial_list':
      group.outcome==='invoice_mismatch'?'invoice_mismatch':'invalid_risk_graph'};
  const list=obj(paymentsRaw);
  if(!Array.isArray(list?.data)||charges.length!==list.data.length)
    return {outcome:'invalid_risk_graph'};
  const verified:Array<{paymentId:string;digest:string}>=[];
  let refunds=0,pending=0n,succeeded=0n,disputes=0,unresolved=0;
  for(let i=0;i<charges.length;i++){
    const payment=obj(list.data[i]);
    const amount=payment?.amount_paid;
    if(typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<=0)
      return {outcome:'invalid_risk_graph'};
    const invoice=obj(invoiceRaw);
    if(!invoice) return {outcome:'invoice_mismatch'};
    // After checking all allocations against the original invoice,
    // inspect each bounded Charge risk list with the strict ADR-117 parser.
    const slicedInvoice={
      ...invoice,amount_paid:amount,total:amount,amount_remaining:0,
    };
    const piece=charges[i];
    if(!piece) return {outcome:'invalid_risk_graph'};
    const parsed=parseStripeTestPaymentRisk(
      slicedInvoice,{object:'list',has_more:false,data:[payment]},
      piece.paymentIntent,piece.charge,piece.refunds,piece.disputes,{
        invoiceId:expected.invoiceId,customerId:expected.customerId,
        subscriptionId:expected.subscriptionId,currency:expected.currency,
        amountPaidMinor:BigInt(amount),paidAt:expected.paidAt,
      },
    );
    if(parsed.outcome!=='valid')
      return {outcome:parsed.outcome==='incomplete_risk_data'
        ?'incomplete_risk_data':'invalid_risk_graph'};
    const risk=parsed.snapshot;
    verified.push({
      paymentId:payment?.id as string,digest:risk.snapshotSha256,
    });
    refunds+=risk.refundCount;
    succeeded+=risk.succeededRefundMinor;
    pending+=risk.pendingRefundMinor;
    disputes+=risk.disputeCount;
    unresolved+=risk.unresolvedDisputeCount;
  }
  if(succeeded+pending>expected.amountPaidMinor)
    return {outcome:'invalid_risk_graph'};
  verified.sort((a,b)=>a.paymentId.localeCompare(b.paymentId));
  const riskDigest=createHash('sha256').update(JSON.stringify({
    groupDigest:group.snapshot.digest,verified,
  })).digest('hex');
  return {outcome:'valid',snapshot:{
    groupDigest:group.snapshot.digest,riskDigest,
    chargeCount:group.snapshot.count,refundCount:refunds,
    succeededRefundMinor:succeeded,pendingRefundMinor:pending,
    disputeCount:disputes,unresolvedDisputeCount:unresolved,
  }};
}
