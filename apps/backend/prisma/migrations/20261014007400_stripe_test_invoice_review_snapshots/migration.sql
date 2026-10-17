BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ADR-116: append-only Stripe TEST invoice review snapshots. Credit notes
-- are observed, NOT financial settlement. Refund verification is impossible
-- at this stage and is permanently false.
CREATE TABLE stripe_test_invoice_reviews (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id)
    ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  snapshot_sha256 VARCHAR(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  line_price_id VARCHAR(255) NOT NULL CHECK (line_price_id ~ '^price_[A-Za-z0-9_-]+$'),
  service_period_start TIMESTAMPTZ(6) NOT NULL,
  service_period_end TIMESTAMPTZ(6) NOT NULL,
  credit_note_count INTEGER NOT NULL CHECK (credit_note_count BETWEEN 0 AND 100),
  issued_credit_minor BIGINT NOT NULL CHECK (issued_credit_minor >= 0),
  state VARCHAR(16) NOT NULL DEFAULT 'observed' CHECK (state='observed'),
  refunds_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK (refunds_verified=FALSE),
  financial_clearance BOOLEAN NOT NULL DEFAULT FALSE CHECK (financial_clearance=FALSE),
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK (billable=FALSE),
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (service_period_end > service_period_start),
  UNIQUE (invoice_id,snapshot_sha256),
  FOREIGN KEY (tenant_id,subscription_id)
    REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_invoice_reviews_tenant_idx
  ON stripe_test_invoice_reviews(tenant_id,observed_at,id);

CREATE TABLE stripe_invoice_review_attempts (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id)
    ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK (
    outcome IN ('recorded','replayed','rejected','deferred')
  ),
  reason VARCHAR(40) NOT NULL CHECK (reason IN (
    'snapshot_observed','already_observed','provider_unavailable',
    'invalid_period','invalid_credit_notes','incomplete_credits',
    'invoice_mismatch','subscription_mismatch','untrusted_checkout'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX invoice_review_attempts_invoice_idx
  ON stripe_invoice_review_attempts(invoice_id,created_at);

ALTER TABLE stripe_test_invoice_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_invoice_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_invoice_reviews_restricted_read ON stripe_test_invoice_reviews
  FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
CREATE POLICY stripe_invoice_reviews_restricted_insert ON stripe_test_invoice_reviews
  FOR INSERT TO melissa_billing_invoice_verifier
  WITH CHECK (
    state='observed' AND financial_clearance=FALSE
    AND refunds_verified=FALSE AND billable=FALSE
    AND EXISTS (
      SELECT 1 FROM stripe_test_invoice_evidence AS e
      WHERE e.invoice_id=stripe_test_invoice_reviews.invoice_id
        AND e.tenant_id=stripe_test_invoice_reviews.tenant_id
        AND e.subscription_id=stripe_test_invoice_reviews.subscription_id
        AND e.billable=FALSE AND e.entitlement_verified=FALSE
        AND e.amount_paid_minor >= stripe_test_invoice_reviews.issued_credit_minor
    )
  );
GRANT SELECT ON stripe_test_invoice_reviews TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
  line_price_id,service_period_start,service_period_end,credit_note_count,
  issued_credit_minor) ON stripe_test_invoice_reviews
  TO melissa_billing_invoice_verifier;

ALTER TABLE stripe_invoice_review_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_invoice_review_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_review_attempts_restricted_read ON stripe_invoice_review_attempts
  FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
CREATE POLICY stripe_review_attempts_restricted_insert ON stripe_invoice_review_attempts
  FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK (TRUE);
GRANT SELECT ON stripe_invoice_review_attempts TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,outcome,reason) ON stripe_invoice_review_attempts
  TO melissa_billing_invoice_verifier;

-- The ADR-115 append-only rejection trigger protects ordinary DML here too.
CREATE TRIGGER invoice_review_snapshots_immutable BEFORE UPDATE OR DELETE
  ON stripe_test_invoice_reviews FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER invoice_review_attempts_immutable BEFORE UPDATE OR DELETE
  ON stripe_invoice_review_attempts FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();

-- No runtime grant. Only an independently provisioned, NOLOGIN-by-default
-- verifier can insert. This is not connected to paid entitlements.
UPDATE infrastructure_metadata SET value='74' WHERE key='schema_version';
COMMIT;
