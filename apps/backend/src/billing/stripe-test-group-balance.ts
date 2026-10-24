import { createHash } from 'node:crypto';
import {
  GroupExpected,
  PaymentGroupLink,
  parseStripeTestPaymentGroup,
} from './stripe-test-payment-group';

export interface LinkedBalanceCharge extends PaymentGroupLink {
  balanceTransaction: unknown;
}
export type GroupBalanceParse =
  | {
      outcome: 'valid';
      snapshot: {
        groupDigest: string;
        balanceDigest: string;
        chargeCount: number;
        grossMinor: bigint;
        feeMinor: bigint;
        netMinor: bigint;
        pendingCount: number;
        availableCount: number;
      };
    }
  | {
      outcome:
        | 'invoice_mismatch'
        | 'partial_list'
        | 'invalid_payment_graph'
        | 'balance_transaction_missing'
        | 'invalid_balance_graph';
    };

const BALANCE_ID = /^txn_[A-Za-z0-9_]{1,250}$/;
function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}
function minor(x: unknown): number | null {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 100_000_000_000
    ? x
    : null;
}
function seconds(x: unknown): number | null {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 1000000000 && x < 253402300800
    ? x
    : null;
}

// A balance transaction available in Stripe's internal balance does not
// establish bank payout or reversal finality. Revalidate ALL group Charges
// and never infer merchant revenue or an entitlement from fees/net.
// prettier-ignore
export function parseStripeTestGroupBalances(
  invoiceRaw:unknown,paymentsRaw:unknown,links:LinkedBalanceCharge[],
  expected:GroupExpected,
):GroupBalanceParse{
  const group=parseStripeTestPaymentGroup(invoiceRaw,paymentsRaw,links,expected);
  if(group.outcome!=='valid') return {outcome:group.outcome==='partial_list'
    ?'partial_list':group.outcome==='invoice_mismatch'
      ?'invoice_mismatch':'invalid_payment_graph'};
  const rows=obj(paymentsRaw)?.data;
  if(!Array.isArray(rows)||rows.length!==links.length)
    return {outcome:'invalid_payment_graph'};
  const pieces:Array<{paymentId:string;transactionId:string;status:string;
    gross:number;fee:number;net:number;availableOn:number;}>= [];
  const txIds=new Set<string>();
  let gross=0n,fees=0n,netTotal=0n,pending=0,available=0;
  for(let i=0;i<links.length;i++){
    const payment=obj(rows[i]);
    const charge=obj(links[i]?.charge);
    const bt=obj(links[i]?.balanceTransaction);
    const transactionId=charge?.balance_transaction;
    if(typeof transactionId!=='string'||!BALANCE_ID.test(transactionId))
      return {outcome:'balance_transaction_missing'};
    const amount=minor(charge?.amount);
    const fee=minor(bt?.fee),net=minor(bt?.net),observed=minor(bt?.amount);
    const availability=seconds(bt?.available_on);
    if(!bt||bt.object!=='balance_transaction'||bt.id!==transactionId||
       txIds.has(transactionId)||bt.source!==charge?.id||
       (bt.type!=='charge'&&bt.type!=='payment')||
       bt.currency!==expected.currency.toLowerCase()||
       (bt.status!=='pending'&&bt.status!=='available')||
       amount===null||amount===0||observed!==amount||
       fee===null||net===null||fee>amount||net!==amount-fee||
       availability===null||
       typeof payment?.id!=='string')
      return {outcome:'invalid_balance_graph'};
    txIds.add(transactionId);
    if(bt.status==='available') available++;else pending++;
    gross+=BigInt(amount);fees+=BigInt(fee);netTotal+=BigInt(net);
    pieces.push({paymentId:payment.id,transactionId,status:bt.status as string,
      gross:amount,fee,net,availableOn:availability});
  }
  if(gross!==expected.amountPaidMinor||netTotal!==gross-fees)
    return {outcome:'invalid_balance_graph'};
  pieces.sort((a,b)=>a.paymentId.localeCompare(b.paymentId));
  const balanceDigest=createHash('sha256').update(JSON.stringify({
    groupDigest:group.snapshot.digest,pieces,
  })).digest('hex');
  return {outcome:'valid',snapshot:{
    groupDigest:group.snapshot.digest,balanceDigest,
    chargeCount:group.snapshot.count,grossMinor:gross,
    feeMinor:fees,netMinor:netTotal,pendingCount:pending,
    availableCount:available,
  }};
}
