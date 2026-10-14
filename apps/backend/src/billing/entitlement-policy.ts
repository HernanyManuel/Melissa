// ADR-113: assessment only. NOT a billing authorization engine or usage
// enforcement. No Stripe "active" status, metadata or plan flag can grant
// paid automation while independently reviewed payment evidence is absent.
export type EntitlementBlocker =
  | 'activation_gate_closed'
  | 'missing_subscription'
  | 'untrusted_checkout'
  | 'unsupported_provider'
  | 'subscription_not_active'
  | 'subscription_period_invalid'
  | 'plan_unavailable'
  | 'billing_verification_missing'
  | 'billable_usage_undefined';

export interface EntitlementFacts {
  gateEnabled: boolean;
  subscriptionPresent: boolean;
  provider: string | null;
  status: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  activePlan: boolean;
  localCheckoutMatched: boolean;
  // Payment ledger and external provider verification are deliberately
  // not implemented in this phase. Never infer this from active status.
  billingVerificationPresent: boolean;
  billableUsageDefined: boolean;
}

export interface CommercialEntitlementDecision {
  automationEnabled: false;
  billingVerified: false;
  allowed: false;
  reason: 'billing_not_enabled';
  policyVersion: 1;
  blockers: EntitlementBlocker[];
}

export function evaluateCommercialEntitlements(
  facts: EntitlementFacts,
  now: Date,
): CommercialEntitlementDecision {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid evaluation time');
  const blockers: EntitlementBlocker[] = [];
  if (!facts.gateEnabled) blockers.push('activation_gate_closed');
  if (!facts.subscriptionPresent) blockers.push('missing_subscription');
  if (facts.subscriptionPresent) {
    if (facts.provider !== 'stripe') blockers.push('unsupported_provider');
    if (facts.status !== 'active') blockers.push('subscription_not_active');
    if (
      !facts.periodStart || !facts.periodEnd ||
      !Number.isFinite(facts.periodStart.getTime()) ||
      !Number.isFinite(facts.periodEnd.getTime()) ||
      facts.periodStart > now || facts.periodEnd <= now ||
      facts.periodEnd <= facts.periodStart
    ) blockers.push('subscription_period_invalid');
    if (!facts.localCheckoutMatched) blockers.push('untrusted_checkout');
    if (!facts.activePlan) blockers.push('plan_unavailable');
  }
  if (!facts.billingVerificationPresent) blockers.push('billing_verification_missing');
  if (!facts.billableUsageDefined) blockers.push('billable_usage_undefined');

  // The "gateEnabled" flag alone must NEVER authorize work. Even if a
  // future migration opens it, this function remains deny-only until
  // provider ledger, pricing policy and concurrency-safe quota reserve exist.
  return {
    automationEnabled: false,
    billingVerified: false,
    allowed: false,
    reason: 'billing_not_enabled',
    policyVersion: 1,
    blockers,
  };
}

export interface ObservedQuota {
  measured: true;
  used: number;
  limit: number | null;
  exceeded: boolean | null;
  enforceable: false;
}

export function observedQuota(used: number, limit: number | null): ObservedQuota {
  if (!Number.isSafeInteger(used) || used < 0 ||
      (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)))
    throw new Error('Invalid quota snapshot');
  return {
    measured: true,
    used,
    limit,
    exceeded: limit === null ? null : used > limit,
    enforceable: false,
  };
}

export const undefinedBillableQuota = {
  measured: false,
  used: null,
  limit: null,
  exceeded: null,
  enforceable: false,
  reason: 'billing_metric_not_defined',
} as const;

export const unmodeledLocationQuota = {
  measured: false,
  used: null,
  limit: null,
  exceeded: null,
  enforceable: false,
  reason: 'locations_not_modeled',
} as const;
