BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ADR-120: TEST Stripe balance-impact observations for previously linked
-- 2..8 charge payment groups. Funds availability is NOT payout settlement.
CREATE TABLE stripe_test_group_balance_reviews (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES stripe_test_invoice_payment_groups(id) ON DELETE RESTRICT,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  observed_charge_count SMALLINT NOT NULL CHECK(observed_charge_count BETWEEN 2 AND 8),
  gross_minor BIGINT NOT NULL CHECK(gross_minor > 0),
  fee_minor BIGINT NOT NULL CHECK(fee_minor >= 0),
  net_minor BIGINT NOT NULL CHECK(net_minor >= 0),
  pending_transaction_count SMALLINT NOT NULL
    CHECK(pending_transaction_count BETWEEN 0 AND observed_charge_count),
  available_transaction_count SMALLINT NOT NULL
    CHECK(available_transaction_count BETWEEN 0 AND observed_charge_count),
  state VARCHAR(16) NOT NULL DEFAULT 'observed' CHECK(state='observed'),
  payout_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK(payout_verified=FALSE),
  settlement_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK(settlement_verified=FALSE),
  financial_clearance BOOLEAN NOT NULL DEFAULT FALSE CHECK(financial_clearance=FALSE),
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK(billable=FALSE),
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(net_minor=gross_minor-fee_minor),
  CHECK(pending_transaction_count+available_transaction_count=observed_charge_count),
  UNIQUE(group_id,snapshot_sha256),
  FOREIGN KEY(tenant_id,subscription_id)
    REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_balance_tenant_time_idx
  ON stripe_test_group_balance_reviews(tenant_id,observed_at,id);

CREATE TABLE stripe_group_balance_attempts (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK(outcome IN ('recorded','replayed','rejected','deferred')),
  reason VARCHAR(40) NOT NULL CHECK(reason IN (
    'balance_observed','already_observed','group_not_observed',
    'group_risk_not_observed','provider_unavailable','subscription_mismatch',
    'untrusted_checkout','invoice_mismatch','invalid_payment_graph',
    'partial_list','invalid_balance_graph','balance_transaction_missing'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX stripe_balance_attempt_invoice_idx
  ON stripe_group_balance_attempts(invoice_id,created_at);

ALTER TABLE stripe_test_group_balance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_group_balance_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_group_balance_verifier_read ON stripe_test_group_balance_reviews
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY stripe_group_balance_verifier_insert ON stripe_test_group_balance_reviews
  FOR INSERT TO melissa_billing_invoice_verifier
  WITH CHECK (
    payout_verified=FALSE AND settlement_verified=FALSE
    AND financial_clearance=FALSE AND billable=FALSE
    AND EXISTS (
      SELECT 1 FROM stripe_test_invoice_payment_groups g
      JOIN stripe_test_invoice_evidence e ON e.invoice_id=g.invoice_id
      WHERE g.id=stripe_test_group_balance_reviews.group_id
        AND g.invoice_id=stripe_test_group_balance_reviews.invoice_id
        AND g.tenant_id=stripe_test_group_balance_reviews.tenant_id
        AND g.subscription_id=stripe_test_group_balance_reviews.subscription_id
        AND g.observed_payment_count=stripe_test_group_balance_reviews.observed_charge_count
        AND g.observed_paid_minor=stripe_test_group_balance_reviews.gross_minor
        AND e.tenant_id=g.tenant_id AND e.subscription_id=g.subscription_id
        AND e.billable=FALSE AND e.entitlement_verified=FALSE
        AND g.billable=FALSE AND g.refund_graph_verified=FALSE
        AND EXISTS (
          SELECT 1 FROM stripe_test_group_charge_risk_reviews r
          WHERE r.group_id=g.id AND r.tenant_id=g.tenant_id
            AND r.subscription_id=g.subscription_id
            AND r.billable=FALSE AND r.financial_clearance=FALSE
        )
    )
  );
GRANT SELECT ON stripe_test_group_balance_reviews TO melissa_billing_invoice_verifier;
GRANT INSERT(id,group_id,invoice_id,tenant_id,subscription_id,
  snapshot_sha256,observed_charge_count,gross_minor,fee_minor,net_minor,
  pending_transaction_count,available_transaction_count)
  ON stripe_test_group_balance_reviews TO melissa_billing_invoice_verifier;

ALTER TABLE stripe_group_balance_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_group_balance_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_balance_attempt_read ON stripe_group_balance_attempts
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY stripe_balance_attempt_insert ON stripe_group_balance_attempts
  FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK(TRUE);
GRANT SELECT ON stripe_group_balance_attempts TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,outcome,reason) ON stripe_group_balance_attempts
  TO melissa_billing_invoice_verifier;

CREATE TRIGGER stripe_group_balance_immutable BEFORE UPDATE OR DELETE
  ON stripe_test_group_balance_reviews FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER stripe_balance_attempt_immutable BEFORE UPDATE OR DELETE
  ON stripe_group_balance_attempts FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();

-- No API runtime permissions and no entitlement/settlement authority.
UPDATE infrastructure_metadata SET value='78' WHERE key='schema_version';
COMMIT;
