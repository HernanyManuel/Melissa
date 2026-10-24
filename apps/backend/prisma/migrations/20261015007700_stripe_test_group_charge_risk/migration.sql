BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ADR-119: risk state observed over EVERY Charge in a linked TEST group.
-- Risk completeness describes only this bounded Stripe GET, never settlement.
CREATE TABLE stripe_test_group_charge_risk_reviews (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES stripe_test_invoice_payment_groups(id) ON DELETE RESTRICT,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  observed_charge_count SMALLINT NOT NULL CHECK(observed_charge_count BETWEEN 2 AND 8),
  observed_refund_count INTEGER NOT NULL CHECK(observed_refund_count BETWEEN 0 AND 800),
  succeeded_refund_minor BIGINT NOT NULL CHECK(succeeded_refund_minor>=0),
  pending_refund_minor BIGINT NOT NULL CHECK(pending_refund_minor>=0),
  observed_dispute_count INTEGER NOT NULL CHECK(observed_dispute_count BETWEEN 0 AND 800),
  unresolved_dispute_count INTEGER NOT NULL CHECK(unresolved_dispute_count BETWEEN 0 AND observed_dispute_count),
  risk_state VARCHAR(16) NOT NULL DEFAULT 'observed' CHECK(risk_state='observed'),
  refund_graph_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK(refund_graph_verified=FALSE),
  settlement_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK(settlement_verified=FALSE),
  financial_clearance BOOLEAN NOT NULL DEFAULT FALSE CHECK(financial_clearance=FALSE),
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK(billable=FALSE),
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id,snapshot_sha256),
  FOREIGN KEY(tenant_id,subscription_id) REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX group_charge_risk_tenant_idx
  ON stripe_test_group_charge_risk_reviews(tenant_id,observed_at,id);

CREATE TABLE stripe_group_charge_risk_attempts (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK(outcome IN ('recorded','replayed','deferred','rejected')),
  reason VARCHAR(40) NOT NULL CHECK(reason IN (
    'risk_observed','already_observed','group_not_observed','provider_unavailable',
    'subscription_mismatch','untrusted_checkout','invoice_mismatch',
    'invalid_payment_graph','partial_list','invalid_risk_graph','incomplete_risk_data'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX group_risk_attempt_invoice_idx
  ON stripe_group_charge_risk_attempts(invoice_id,created_at);

ALTER TABLE stripe_test_group_charge_risk_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_group_charge_risk_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY group_charge_risk_verifier_read ON stripe_test_group_charge_risk_reviews
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY group_charge_risk_verifier_insert ON stripe_test_group_charge_risk_reviews
  FOR INSERT TO melissa_billing_invoice_verifier
  WITH CHECK (
    refund_graph_verified=FALSE AND settlement_verified=FALSE
    AND financial_clearance=FALSE AND billable=FALSE
    AND EXISTS (
      SELECT 1 FROM stripe_test_invoice_payment_groups AS g
      JOIN stripe_test_invoice_evidence AS e ON e.invoice_id=g.invoice_id
      WHERE g.id=stripe_test_group_charge_risk_reviews.group_id
        AND g.invoice_id=stripe_test_group_charge_risk_reviews.invoice_id
        AND g.tenant_id=stripe_test_group_charge_risk_reviews.tenant_id
        AND g.subscription_id=stripe_test_group_charge_risk_reviews.subscription_id
        AND g.observed_payment_count=stripe_test_group_charge_risk_reviews.observed_charge_count
        AND e.tenant_id=g.tenant_id AND e.subscription_id=g.subscription_id
        AND g.refund_graph_verified=FALSE AND g.billable=FALSE
        AND e.billable=FALSE AND e.entitlement_verified=FALSE
        AND e.amount_paid_minor >= stripe_test_group_charge_risk_reviews.succeeded_refund_minor
    )
  );
GRANT SELECT ON stripe_test_group_charge_risk_reviews TO melissa_billing_invoice_verifier;
GRANT INSERT(id,group_id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
 observed_charge_count,observed_refund_count,succeeded_refund_minor,
 pending_refund_minor,observed_dispute_count,unresolved_dispute_count)
 ON stripe_test_group_charge_risk_reviews TO melissa_billing_invoice_verifier;

ALTER TABLE stripe_group_charge_risk_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_group_charge_risk_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY group_risk_attempt_verifier_read ON stripe_group_charge_risk_attempts
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY group_risk_attempt_verifier_insert ON stripe_group_charge_risk_attempts
  FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK(TRUE);
GRANT SELECT ON stripe_group_charge_risk_attempts TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,outcome,reason) ON stripe_group_charge_risk_attempts
  TO melissa_billing_invoice_verifier;

CREATE TRIGGER group_charge_risk_immutable BEFORE UPDATE OR DELETE
  ON stripe_test_group_charge_risk_reviews FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER group_charge_risk_attempt_immutable BEFORE UPDATE OR DELETE
  ON stripe_group_charge_risk_attempts FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();

UPDATE infrastructure_metadata SET value='77' WHERE key='schema_version';
COMMIT;
