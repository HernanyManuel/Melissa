BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- ADR-115: test Stripe invoice snapshots; never billable or entitlement proof.
CREATE TABLE stripe_test_invoice_evidence (
 invoice_id VARCHAR(255) PRIMARY KEY CHECK (invoice_id ~ '^in_[A-Za-z0-9_]+$'),
 tenant_id UUID NOT NULL,
 subscription_id UUID NOT NULL,
 source_event_id VARCHAR(255) NOT NULL REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
 provider_customer_id VARCHAR(255) NOT NULL CHECK (provider_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
 provider_subscription_id VARCHAR(255) NOT NULL CHECK (provider_subscription_id ~ '^sub_[A-Za-z0-9_]+$'),
 currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 amount_paid_minor BIGINT NOT NULL CHECK (amount_paid_minor > 0),
 invoice_paid_at TIMESTAMPTZ(6) NOT NULL,
 observed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status VARCHAR(16) NOT NULL DEFAULT 'paid' CHECK (status='paid'),
 billable BOOLEAN NOT NULL DEFAULT FALSE CHECK (billable=FALSE),
 entitlement_verified BOOLEAN NOT NULL DEFAULT FALSE CHECK (entitlement_verified=FALSE),
 FOREIGN KEY (tenant_id,subscription_id) REFERENCES subscriptions(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX invoice_evidence_tenant_idx ON stripe_test_invoice_evidence(tenant_id,observed_at,invoice_id);
CREATE TABLE stripe_invoice_evidence_attempts (
 id UUID PRIMARY KEY,
 event_id VARCHAR(255) NOT NULL REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
 outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('recorded','replayed','rejected','deferred')),
 reason VARCHAR(40) NOT NULL CHECK (reason IN (
  'provider_verified','already_recorded','unsupported_event','unknown_subscription',
  'invalid_provider_snapshot','provider_unavailable','invoice_mismatch',
  'subscription_mismatch','untrusted_checkout','binding_conflict'
 )),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX invoice_evidence_attempts_event_idx ON stripe_invoice_evidence_attempts(event_id,created_at);
DO $role$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='melissa_billing_invoice_verifier') THEN
  CREATE ROLE melissa_billing_invoice_verifier NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $role$;
GRANT USAGE ON SCHEMA public TO melissa_billing_invoice_verifier;
CREATE POLICY stripe_invoice_event_read ON stripe_webhook_events FOR SELECT TO melissa_billing_invoice_verifier USING (livemode=FALSE);
GRANT SELECT(event_id,event_type,payload,livemode) ON stripe_webhook_events TO melissa_billing_invoice_verifier;
CREATE POLICY stripe_invoice_sub_read ON subscriptions FOR SELECT TO melissa_billing_invoice_verifier USING (provider='stripe');
GRANT SELECT(id,tenant_id,plan_id,provider,provider_customer_id,provider_subscription_id,checkout_session_id,status)
 ON subscriptions TO melissa_billing_invoice_verifier;
CREATE POLICY stripe_invoice_checkout_read ON stripe_checkout_intents FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
GRANT SELECT(id,tenant_id,plan_id,stripe_price_id,status,checkout_session_id)
 ON stripe_checkout_intents TO melissa_billing_invoice_verifier;
GRANT SELECT(id,currency,stripe_price_id,active) ON plans TO melissa_billing_invoice_verifier;
ALTER TABLE stripe_test_invoice_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_test_invoice_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_evidence_verifier_read ON stripe_test_invoice_evidence FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
CREATE POLICY invoice_evidence_verifier_insert ON stripe_test_invoice_evidence
 FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK (
  status='paid' AND billable=FALSE AND entitlement_verified=FALSE
  AND EXISTS (
   SELECT 1 FROM subscriptions AS s JOIN plans AS p ON p.id=s.plan_id
   JOIN stripe_checkout_intents AS i ON i.tenant_id=s.tenant_id AND i.plan_id=s.plan_id
    AND i.checkout_session_id=s.checkout_session_id
   WHERE s.tenant_id=stripe_test_invoice_evidence.tenant_id
     AND s.id=stripe_test_invoice_evidence.subscription_id
     AND s.provider='stripe' AND s.checkout_session_id IS NOT NULL
     AND s.provider_customer_id=stripe_test_invoice_evidence.provider_customer_id
     AND s.provider_subscription_id=stripe_test_invoice_evidence.provider_subscription_id
     AND i.status='ready' AND p.active AND p.stripe_price_id=i.stripe_price_id
  )
  AND EXISTS (
   SELECT 1 FROM stripe_webhook_events AS e
   WHERE e.event_id=stripe_test_invoice_evidence.source_event_id
    AND e.event_type='invoice.paid' AND e.livemode=FALSE
    AND e.payload->'data'->'object'->>'id'=stripe_test_invoice_evidence.invoice_id
  )
 );
GRANT SELECT ON stripe_test_invoice_evidence TO melissa_billing_invoice_verifier;
GRANT INSERT(invoice_id,tenant_id,subscription_id,source_event_id,
 provider_customer_id,provider_subscription_id,currency,amount_paid_minor,invoice_paid_at)
 ON stripe_test_invoice_evidence TO melissa_billing_invoice_verifier;
CREATE POLICY invoice_evidence_runtime_read ON stripe_test_invoice_evidence FOR SELECT TO melissa_runtime
 USING (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT(tenant_id,status,billable,entitlement_verified) ON stripe_test_invoice_evidence TO melissa_runtime;
ALTER TABLE stripe_invoice_evidence_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_invoice_evidence_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_attempts_verifier_read ON stripe_invoice_evidence_attempts FOR SELECT TO melissa_billing_invoice_verifier USING (TRUE);
CREATE POLICY invoice_attempts_verifier_insert ON stripe_invoice_evidence_attempts FOR INSERT TO melissa_billing_invoice_verifier WITH CHECK (TRUE);
GRANT SELECT ON stripe_invoice_evidence_attempts TO melissa_billing_invoice_verifier;
GRANT INSERT(id,event_id,outcome,reason) ON stripe_invoice_evidence_attempts TO melissa_billing_invoice_verifier;
CREATE FUNCTION public.prevent_stripe_invoice_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $func$
BEGIN RAISE EXCEPTION 'invoice evidence is immutable'; END
$func$;
REVOKE ALL ON FUNCTION public.prevent_stripe_invoice_evidence_mutation() FROM PUBLIC;
CREATE TRIGGER invoice_evidence_immutable BEFORE UPDATE OR DELETE ON stripe_test_invoice_evidence
 FOR EACH ROW EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
CREATE TRIGGER invoice_attempts_immutable BEFORE UPDATE OR DELETE ON stripe_invoice_evidence_attempts
 FOR EACH ROW EXECUTE FUNCTION public.prevent_stripe_invoice_evidence_mutation();
UPDATE infrastructure_metadata SET value='73' WHERE key='schema_version';
COMMIT;
