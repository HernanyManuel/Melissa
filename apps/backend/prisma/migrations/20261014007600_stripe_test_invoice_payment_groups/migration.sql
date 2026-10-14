BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ADR-118: independent, immutable observation of 2..8 TEST InvoicePayments.
-- This ledger is deliberately NOT a receipt, financial settlement, refund
-- reconciliation or entitlement. Single-payment risk remains ADR-117.
CREATE TABLE stripe_test_invoice_payment_groups (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL
    REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL
    CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  observed_payment_count SMALLINT NOT NULL
    CHECK (observed_payment_count BETWEEN 2 AND 8),
  observed_paid_minor BIGINT NOT NULL CHECK (observed_paid_minor > 0),
  refund_graph_verified BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (refund_graph_verified=FALSE),
  settlement_verified BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (settlement_verified=FALSE),
  financial_clearance BOOLEAN NOT NULL DEFAULT FALSE
    CHECK (financial_clearance=FALSE),
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK (billable=FALSE),
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_id,snapshot_sha256),
  FOREIGN KEY (tenant_id,subscription_id)
    REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_invoice_payment_groups_tenant_idx
  ON stripe_test_invoice_payment_groups(tenant_id,observed_at,id);
CREATE TABLE stripe_invoice_payment_group_attempts (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL
    REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL
    CHECK (outcome IN ('recorded','replayed','rejected','deferred')),
  reason VARCHAR(40) NOT NULL CHECK(reason IN (
    'group_observed','already_observed','provider_unavailable',
    'untrusted_checkout','subscription_mismatch','invoice_mismatch',
    'partial_list','unsupported_payment_count','invalid_payment_graph'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX payment_group_attempts_invoice_idx
  ON stripe_invoice_payment_group_attempts(invoice_id,created_at);

ALTER TABLE stripe_test_invoice_payment_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_invoice_payment_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY group_verifier_read ON stripe_test_invoice_payment_groups
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY group_verifier_insert ON stripe_test_invoice_payment_groups
  FOR INSERT TO melissa_billing_invoice_verifier
  WITH CHECK (
    refund_graph_verified=FALSE AND settlement_verified=FALSE
    AND financial_clearance=FALSE AND billable=FALSE
    AND EXISTS(
      SELECT 1 FROM stripe_test_invoice_evidence AS e
      WHERE e.invoice_id=stripe_test_invoice_payment_groups.invoice_id
        AND e.tenant_id=stripe_test_invoice_payment_groups.tenant_id
        AND e.subscription_id=stripe_test_invoice_payment_groups.subscription_id
        AND e.billable=FALSE AND e.entitlement_verified=FALSE
        AND e.amount_paid_minor=stripe_test_invoice_payment_groups.observed_paid_minor
    )
  );
GRANT SELECT ON stripe_test_invoice_payment_groups
  TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,tenant_id,subscription_id,snapshot_sha256,
             observed_payment_count,observed_paid_minor)
  ON stripe_test_invoice_payment_groups
  TO melissa_billing_invoice_verifier;

ALTER TABLE stripe_invoice_payment_group_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_invoice_payment_group_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY group_attempt_verifier_read ON stripe_invoice_payment_group_attempts
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY group_attempt_verifier_insert ON stripe_invoice_payment_group_attempts
  FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK(TRUE);
GRANT SELECT ON stripe_invoice_payment_group_attempts
  TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,outcome,reason)
  ON stripe_invoice_payment_group_attempts
  TO melissa_billing_invoice_verifier;

CREATE TRIGGER invoice_payment_groups_immutable BEFORE UPDATE OR DELETE
  ON stripe_test_invoice_payment_groups FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER invoice_payment_group_attempts_immutable BEFORE UPDATE OR DELETE
  ON stripe_invoice_payment_group_attempts FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();

UPDATE infrastructure_metadata SET value='76' WHERE key='schema_version';
COMMIT;
