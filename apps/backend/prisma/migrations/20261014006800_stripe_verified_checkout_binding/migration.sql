BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ADR-110: one-time, separately authorized association of a verified test
-- Checkout Session to a tenant. No account activation or payment entitlements.
ALTER TABLE subscriptions
  ADD COLUMN checkout_session_id VARCHAR(255)
    CHECK (checkout_session_id IS NULL OR checkout_session_id ~ '^cs_test_[A-Za-z0-9_]+$');
CREATE UNIQUE INDEX subscriptions_checkout_session_unique
  ON subscriptions(checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

CREATE TABLE stripe_checkout_link_attempts (
  id UUID PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
  intent_id UUID REFERENCES stripe_checkout_intents(id) ON DELETE RESTRICT,
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('linked','replayed','rejected','deferred')),
  reason VARCHAR(40) NOT NULL CHECK (reason IN (
    'provider_verified','already_linked','event_not_eligible',
    'unknown_checkout','intent_not_ready','provider_unavailable',
    'invalid_provider_snapshot','session_mismatch','subscription_mismatch',
    'payment_not_verified','binding_conflict'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((outcome IN ('linked','replayed') AND tenant_id IS NOT NULL AND
           intent_id IS NOT NULL) OR outcome NOT IN ('linked','replayed'))
);
CREATE INDEX stripe_checkout_link_attempts_event_idx
  ON stripe_checkout_link_attempts(event_id,created_at);

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='melissa_billing_linker') THEN
    CREATE ROLE melissa_billing_linker NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$role$;
GRANT USAGE ON SCHEMA public TO melissa_billing_linker;

-- The linker reads the immutable signed event. No rights to modify it.
CREATE POLICY stripe_events_linker_read ON stripe_webhook_events
  FOR SELECT TO melissa_billing_linker USING (livemode=FALSE);
GRANT SELECT (event_id,event_type,payload,livemode)
  ON stripe_webhook_events TO melissa_billing_linker;

-- A global linker discovers intents only by stored test-session ID.
CREATE POLICY stripe_checkout_linker_read ON stripe_checkout_intents
  FOR SELECT TO melissa_billing_linker USING (TRUE);
GRANT SELECT (id,tenant_id,plan_id,stripe_price_id,status,expires_at,
              created_at,checkout_session_id)
  ON stripe_checkout_intents TO melissa_billing_linker;
GRANT SELECT (id,stripe_price_id,active) ON plans TO melissa_billing_linker;

CREATE POLICY subscriptions_linker_select ON subscriptions
  FOR SELECT TO melissa_billing_linker USING (provider='stripe');
CREATE POLICY subscriptions_linker_insert ON subscriptions
  FOR INSERT TO melissa_billing_linker
  WITH CHECK (
    provider='stripe' AND checkout_session_id IS NOT NULL AND
    EXISTS (
      SELECT 1
      FROM stripe_checkout_intents AS i
      JOIN plans AS p ON p.id=i.plan_id
      WHERE i.tenant_id=subscriptions.tenant_id AND i.plan_id=subscriptions.plan_id
        AND i.checkout_session_id=subscriptions.checkout_session_id
        AND i.status='ready' AND i.stripe_price_id=p.stripe_price_id
        AND p.active
    )
  );
GRANT SELECT (id,tenant_id,plan_id,provider,provider_customer_id,
              provider_subscription_id,checkout_session_id)
  ON subscriptions TO melissa_billing_linker;
GRANT INSERT (id,tenant_id,plan_id,provider,provider_customer_id,
              provider_subscription_id,status,current_period_start,current_period_end,
              cancel_at_period_end,trial_end,checkout_session_id)
  ON subscriptions TO melissa_billing_linker;

ALTER TABLE stripe_checkout_link_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_checkout_link_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY checkout_link_attempts_read ON stripe_checkout_link_attempts
  FOR SELECT TO melissa_billing_linker USING (TRUE);
CREATE POLICY checkout_link_attempts_insert ON stripe_checkout_link_attempts
  FOR INSERT TO melissa_billing_linker WITH CHECK (TRUE);
GRANT SELECT ON stripe_checkout_link_attempts TO melissa_billing_linker;
GRANT INSERT (id,event_id,intent_id,tenant_id,outcome,reason)
  ON stripe_checkout_link_attempts TO melissa_billing_linker;

-- Runtime and reconciler retain their original restrictions; they cannot
-- create subscriptions or alter checkout_session_id. Linker cannot update them.
UPDATE infrastructure_metadata SET value='68' WHERE key='schema_version';
COMMIT;
