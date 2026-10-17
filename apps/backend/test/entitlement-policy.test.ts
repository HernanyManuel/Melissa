import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateCommercialEntitlements,
  observedQuota,
  undefinedBillableQuota,
  unmodeledLocationQuota,
  EntitlementFacts,
} from '../src/billing/entitlement-policy';

const now = new Date('2026-10-14T12:00:00.000Z');
const eligible: EntitlementFacts = {
  gateEnabled: false,
  subscriptionPresent: true,
  provider: 'stripe',
  status: 'active',
  periodStart: new Date('2026-10-01T00:00:00Z'),
  periodEnd: new Date('2026-11-01T00:00:00Z'),
  activePlan: true,
  localCheckoutMatched: true,
  billingVerificationPresent: false,
  billableUsageDefined: false,
};

test('commercial entitlements deny even paid-looking and compromised snapshots', () => {
  const variants: Array<Partial<EntitlementFacts>> = [
    {},
    { gateEnabled: true },
    { gateEnabled: true, billingVerificationPresent: true },
    { gateEnabled: true, billingVerificationPresent: true, billableUsageDefined: true },
    { status: 'past_due' },
    { status: 'trialing' },
    { provider: 'other' },
    { activePlan: false },
    { localCheckoutMatched: false },
    { periodStart: new Date('2026-10-15T00:00:00Z') },
    { periodEnd: now },
    { periodEnd: new Date('2026-09-01T00:00:00Z') },
    { subscriptionPresent: false },
  ];
  for (const variant of variants) {
    const actual = evaluateCommercialEntitlements({ ...eligible, ...variant }, now);
    assert.equal(actual.allowed, false);
    assert.equal(actual.automationEnabled, false);
    assert.equal(actual.billingVerified, false);
    assert.equal(actual.reason, 'billing_not_enabled');
    assert.equal(actual.policyVersion, 1);
  }
  const result = evaluateCommercialEntitlements(eligible, now);
  assert.deepEqual(result.blockers, [
    'activation_gate_closed',
    'billing_verification_missing',
    'billable_usage_undefined',
  ]);
  assert(
    evaluateCommercialEntitlements(
      { ...eligible, localCheckoutMatched: false },
      now,
    ).blockers.includes('untrusted_checkout'),
  );
  assert(
    evaluateCommercialEntitlements({ ...eligible, status: 'trialing' }, now).blockers.includes(
      'subscription_not_active',
    ),
  );
  assert(
    evaluateCommercialEntitlements(
      { ...eligible, subscriptionPresent: false },
      now,
    ).blockers.includes('missing_subscription'),
  );
  assert.throws(() => evaluateCommercialEntitlements(eligible, new Date('invalid')));
});

test('quota previews never become enforceable or invent billable usage', () => {
  assert.deepEqual(observedQuota(2, 1), {
    measured: true,
    used: 2,
    limit: 1,
    exceeded: true,
    enforceable: false,
  });
  assert.equal(observedQuota(1, 1).exceeded, false);
  assert.equal(observedQuota(0, null).exceeded, null);
  for (const value of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => observedQuota(value, 3));
  }
  assert.throws(() => observedQuota(3, -1));
  assert.equal(undefinedBillableQuota.measured, false);
  assert.equal(undefinedBillableQuota.used, null);
  assert.equal(unmodeledLocationQuota.measured, false);
  assert.equal(unmodeledLocationQuota.enforceable, false);
});
