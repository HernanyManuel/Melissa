BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ADR-117: current Stripe TEST refunds/dispute risk observations only.
-- A charge must be linked through the Stripe InvoicePayment -> PI graph
-- to a pre-bound invoice. Zero observations never means final clearance.
CREATE TABLE stripe_test_payment_risk_reviews (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  payment_intent_id VARCHAR(255) NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  charge_id VARCHAR(255) NOT NULL CHECK (charge_id ~ '^ch_[A-Za-z0-9_]+$'),
  refund_count INTEGER NOT NULL CHECK (refund_count BETWEEN 0 AND 100),
  succeeded_refund_minor BIGINT NOT NULL CHECK (succeeded_refund_minor >= 0),
  pending_refund_minor BIGINT NOT NULL CHECK (pending_refund_minor >= 0),
  dispute_count INTEGER NOT NULL CHECK (dispute_count BETWEEN 0 AND 100),
  unresolved_dispute_count INTEGER NOT NULL CHECK (unresolved_dispute_count BETWEEN 0 AND dispute_count),
  risk_state VARCHAR(16) NOT NULL DEFAULT 'observed' CHECK (risk_state='observed'),
  settlement_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK (settlement_verified=FALSE),
  refunds_final BOOLEAN NOT NULL DEFAULT FALSE CHECK (refunds_final=FALSE),
  financial_clearance BOOLEAN NOT NULL DEFAULT FALSE CHECK (financial_clearance=FALSE),
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK (billable=FALSE),
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (invoice_id,snapshot_sha256),
  FOREIGN KEY (tenant_id,subscription_id)
    REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_risk_tenant_time_idx ON stripe_test_payment_risk_reviews(tenant_id,observed_at,id);

CREATE TABLE stripe_payment_risk_attempts (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK(outcome IN ('recorded','replayed','rejected','deferred')),
  reason VARCHAR(40) NOT NULL CHECK(reason IN (
    'snapshot_observed','already_observed','provider_unavailable',
    'invoice_mismatch','subscription_mismatch','untrusted_checkout',
    'payment_mapping_invalid','payment_mapping_incomplete',
    'charge_mismatch','invalid_refund_list','invalid_dispute_list',
    'incomplete_risk_data'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX stripe_risk_attempt_invoice_idx ON stripe_payment_risk_attempts(invoice_id,created_at);

ALTER TABLE stripe_test_payment_risk_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_payment_risk_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY risk_review_verifier_read ON stripe_test_payment_risk_reviews
  FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
CREATE POLICY risk_review_verifier_insert ON stripe_test_payment_risk_reviews
  FOR INSERT TO melissa_billing_invoice_verifier
  WITH CHECK (
    risk_state='observed' AND financial_clearance=FALSE AND billable=FALSE
    AND settlement_verified=FALSE AND refunds_final=FALSE
    AND EXISTS (
      SELECT 1 FROM stripe_test_invoice_evidence AS e
      WHERE e.invoice_id=stripe_test_payment_risk_reviews.invoice_id
        AND e.tenant_id=stripe_test_payment_risk_reviews.tenant_id
        AND e.subscription_id=stripe_test_payment_risk_reviews.subscription_id
        AND e.billable=FALSE AND e.entitlement_verified=FALSE
        AND e.amount_paid_minor >=
          stripe_test_payment_risk_reviews.succeeded_refund_minor
    )
  );
GRANT SELECT ON stripe_test_payment_risk_reviews TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
             payment_intent_id,charge_id,refund_count,
             succeeded_refund_minor,pending_refund_minor,
             dispute_count,unresolved_dispute_count)
  ON stripe_test_payment_risk_reviews TO melissa_billing_invoice_verifier;

ALTER TABLE stripe_payment_risk_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_payment_risk_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY risk_attempt_verifier_read ON stripe_payment_risk_attempts
  FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
CREATE POLICY risk_attempt_verifier_insert ON stripe_payment_risk_attempts
  FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK(TRUE);
GRANT SELECT ON stripe_payment_risk_attempts TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,outcome,reason) ON stripe_payment_risk_attempts
  TO melissa_billing_invoice_verifier;

CREATE TRIGGER stripe_payment_risk_immutable BEFORE UPDATE OR DELETE
  ON stripe_test_payment_risk_reviews FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER stripe_risk_attempts_immutable BEFORE UPDATE OR DELETE
  ON stripe_payment_risk_attempts FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();

-- No runtime API grants, no invoice clearing, no entitlement mutation.
UPDATE infrastructure_metadata SET value='75' WHERE key='schema_version';
COMMIT;
