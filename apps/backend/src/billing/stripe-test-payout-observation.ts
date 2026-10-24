import { createHash } from 'node:crypto';

// ADR-121 foundation: provider-only evidence, not a banking or commercial assertion.
// The caller MUST derive expected balance transaction IDs from a trusted ADR-120
// snapshot revalidated against its Stripe TEST Charges, never from HTTP input.
// prettier-ignore
export interface ExpectedPayoutBalance {
  id: string;
  source: string;
  currency: string;
  netMinor: number;
}
// prettier-ignore
export type PayoutObservation =
  | { outcome: 'observed'; digest: string; payoutId: string; includedCount: number;
      observedNetMinor: bigint; settlementVerified: false; billable: false }
  | { outcome: 'deferred' | 'rejected'; reason: string };

const ID = /^txn_[A-Za-z0-9_]{1,250}$/;
const PAYOUT = /^po_[A-Za-z0-9_]{1,250}$/;
const CHARGE = /^ch_[A-Za-z0-9_]{1,250}$/;
// prettier-ignore
function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? x as Record<string, unknown> : null;
}
// prettier-ignore
function money(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) &&
    x >= -100_000_000_000 && x <= 100_000_000_000;
}
// The balance_transactions?payout=... filter is documented ONLY for automatic
// payouts. A manual payout cannot be assigned to an individual Charge here.
// List completion must be proved using ADR-118's bounded pagination helper.
// prettier-ignore
export function observeAutomaticStripeTestPayout(
  payoutRaw: unknown,
  boundedTransactionsRaw: unknown,
  expected: readonly ExpectedPayoutBalance[],
): PayoutObservation {
  const payout = obj(payoutRaw);
  const list = obj(boundedTransactionsRaw);
  if (!payout || payout.object !== 'payout' || payout.livemode !== false ||
      typeof payout.id !== 'string' || !PAYOUT.test(payout.id) ||
      typeof payout.currency !== 'string' ||
      !/^[a-z]{3}$/.test(payout.currency) || !money(payout.amount) ||
      payout.amount <= 0)
    return { outcome: 'rejected', reason: 'invalid_test_payout' };
  if (payout.automatic !== true)
    return { outcome: 'deferred', reason: 'manual_payout_not_attributable' };
  if (payout.reconciliation_status !== 'completed' ||
      payout.status !== 'paid')
    return { outcome: 'deferred', reason: 'payout_not_reconciled' };
  if (!list || list.object !== 'list' || !Array.isArray(list.data) ||
      typeof list.has_more !== 'boolean')
    return { outcome: 'rejected', reason: 'malformed_provider_list' };
  if (list.has_more) return { outcome: 'deferred', reason: 'partial_list' };
  if (expected.length < 2 || expected.length > 8)
    return { outcome: 'rejected', reason: 'invalid_charge_group' };
  const wanted = new Map<string, ExpectedPayoutBalance>();
  const sources = new Set<string>();
  for (const x of expected) {
    if (!ID.test(x.id) || !CHARGE.test(x.source) ||
        x.currency !== payout.currency || !money(x.netMinor) ||
        x.netMinor < 0 || wanted.has(x.id) || sources.has(x.source))
      return { outcome: 'rejected', reason: 'invalid_expected_graph' };
    wanted.set(x.id, x);
    sources.add(x.source);
  }
  const seen = new Set<string>();
  for (const raw of list.data) {
    const row = obj(raw);
    if (!row || row.object !== 'balance_transaction' ||
        typeof row.id !== 'string' || !ID.test(row.id) ||
        seen.has(row.id))
      return { outcome: 'rejected', reason: 'invalid_transaction_list' };
    seen.add(row.id);
    const want = wanted.get(row.id);
    if (!want) continue; // Other Stripe account movements may be in the payout.
    if (row.source !== want.source || row.currency !== want.currency ||
        (row.type !== 'charge' && row.type !== 'payment') ||
        row.net !== want.netMinor)
      return { outcome: 'rejected', reason: 'transaction_mismatch' };
  }
  if ([...wanted.keys()].some(id => !seen.has(id)))
    return { outcome: 'deferred', reason: 'group_not_fully_in_payout' };
  const pieces = [...wanted.values()].sort((a, b) => a.id.localeCompare(b.id));
  const observedNetMinor = pieces.reduce((sum, x) => sum + BigInt(x.netMinor), 0n);
  const digest = createHash('sha256').update(JSON.stringify({
    payoutId: payout.id, status: payout.status,
    reconciliationStatus: payout.reconciliation_status, pieces,
  })).digest('hex');
  // Stripe reports a payout; it does NOT attest final bank receipt.
  return { outcome: 'observed', digest, payoutId: payout.id,
    includedCount: pieces.length, observedNetMinor,
    settlementVerified: false, billable: false };
}
