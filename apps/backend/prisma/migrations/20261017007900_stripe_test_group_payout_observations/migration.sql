BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ADR-121: observational TEST-only payout membership, not bank settlement.
CREATE TABLE stripe_test_group_payout_observations (
  id UUID PRIMARY KEY,
  balance_review_id UUID NOT NULL REFERENCES stripe_test_group_balance_reviews(id) ON DELETE RESTRICT,
  group_id UUID NOT NULL REFERENCES stripe_test_invoice_payment_groups(id) ON DELETE RESTRICT,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  payout_id VARCHAR(255) NOT NULL CHECK(payout_id ~ '^po_[A-Za-z0-9_]{1,250}$'),
  snapshot_sha256 CHAR(64) NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  included_charge_count SMALLINT NOT NULL CHECK(included_charge_count BETWEEN 2 AND 8),
  observed_net_minor BIGINT NOT NULL CHECK(observed_net_minor >= 0),
  state VARCHAR(16) NOT NULL DEFAULT 'observed' CHECK(state='observed'),
  payout_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK(payout_verified=FALSE),
  settlement_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK(settlement_verified=FALSE),
  financial_clearance BOOLEAN NOT NULL DEFAULT FALSE CHECK(financial_clearance=FALSE),
  billable BOOLEAN NOT NULL DEFAULT FALSE CHECK(billable=FALSE),
  observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(balance_review_id,payout_id,snapshot_sha256),
  FOREIGN KEY(tenant_id,subscription_id) REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_group_payout_tenant_time_idx
 ON stripe_test_group_payout_observations(tenant_id,observed_at,id);

CREATE TABLE stripe_group_payout_attempts (
  id UUID PRIMARY KEY,
  invoice_id VARCHAR(255) NOT NULL REFERENCES stripe_test_invoice_evidence(invoice_id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK(outcome IN ('recorded','replayed','rejected','deferred')),
  reason VARCHAR(40) NOT NULL CHECK(reason IN (
    'payout_observed','already_observed','provider_unavailable','untrusted_chain',
    'invalid_payout','manual_payout','unreconciled_payout','partial_list',
    'transaction_mismatch','group_not_in_payout'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX stripe_group_payout_attempt_invoice_idx
 ON stripe_group_payout_attempts(invoice_id,created_at);

ALTER TABLE stripe_test_group_payout_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_group_payout_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_group_payout_select ON stripe_test_group_payout_observations
 FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY stripe_group_payout_insert ON stripe_test_group_payout_observations
 FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK (
   payout_verified=FALSE AND settlement_verified=FALSE
   AND financial_clearance=FALSE AND billable=FALSE
   AND EXISTS (
     SELECT 1 FROM stripe_test_group_balance_reviews b
     JOIN stripe_test_invoice_payment_groups g ON g.id=b.group_id
     JOIN stripe_test_invoice_evidence e ON e.invoice_id=b.invoice_id
     WHERE b.id=stripe_test_group_payout_observations.balance_review_id
       AND b.group_id=stripe_test_group_payout_observations.group_id
       AND b.invoice_id=stripe_test_group_payout_observations.invoice_id
       AND b.tenant_id=stripe_test_group_payout_observations.tenant_id
       AND b.subscription_id=stripe_test_group_payout_observations.subscription_id
       AND b.observed_charge_count=stripe_test_group_payout_observations.included_charge_count
       AND b.net_minor=stripe_test_group_payout_observations.observed_net_minor
       AND b.pending_transaction_count=0
       AND b.payout_verified=FALSE AND b.settlement_verified=FALSE
       AND b.financial_clearance=FALSE AND b.billable=FALSE
       AND g.tenant_id=b.tenant_id AND g.subscription_id=b.subscription_id
       AND g.invoice_id=b.invoice_id AND g.billable=FALSE
       AND e.tenant_id=b.tenant_id AND e.subscription_id=b.subscription_id
       AND e.billable=FALSE AND e.entitlement_verified=FALSE
   )
 );
GRANT SELECT ON stripe_test_group_payout_observations TO melissa_billing_invoice_verifier;
GRANT INSERT(id,balance_review_id,group_id,invoice_id,tenant_id,subscription_id,
  payout_id,snapshot_sha256,included_charge_count,observed_net_minor)
  ON stripe_test_group_payout_observations TO melissa_billing_invoice_verifier;

ALTER TABLE stripe_group_payout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_group_payout_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_group_payout_attempt_read ON stripe_group_payout_attempts
  FOR SELECT TO melissa_billing_invoice_verifier USING(TRUE);
CREATE POLICY stripe_group_payout_attempt_insert ON stripe_group_payout_attempts
  FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK(TRUE);
GRANT SELECT ON stripe_group_payout_attempts TO melissa_billing_invoice_verifier;
GRANT INSERT(id,invoice_id,outcome,reason) ON stripe_group_payout_attempts
 TO melissa_billing_invoice_verifier;

CREATE TRIGGER stripe_group_payout_immutable BEFORE UPDATE OR DELETE
 ON stripe_test_group_payout_observations FOR EACH ROW
 EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER stripe_group_payout_attempt_immutable BEFORE UPDATE OR DELETE
 ON stripe_group_payout_attempts FOR EACH ROW
 EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();

-- No grants to runtime and no commercial changes.
UPDATE infrastructure_metadata SET value='79' WHERE key='schema_version' AND value='78';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM infrastructure_metadata WHERE key='schema_version' AND value='79') THEN
   RAISE EXCEPTION 'Expected schema 78 before ADR-121';
 END IF;
END $$;
COMMIT;
