BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- ADR-111: durable, globally queued test-mode signed Stripe events.
-- Inserted inside the SAME transaction as the webhook event; API/worker
-- have no direct queue grants and cannot forge dispatch work.
CREATE TABLE stripe_event_dispatch (
  event_id VARCHAR(255) PRIMARY KEY REFERENCES stripe_webhook_events(event_id)
    ON DELETE RESTRICT,
  event_type VARCHAR(128) NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','complete','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_until TIMESTAMPTZ(6),
  last_reason VARCHAR(40),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (last_reason IS NULL OR last_reason IN (
    'linked','replayed','applied','unmapped','rejected','skipped','deferred',
    'provider_unavailable','handler_error','lease_expired'
  ))
);
CREATE INDEX stripe_event_dispatch_due_idx
  ON stripe_event_dispatch(next_attempt_at,event_id)
  WHERE state IN ('pending','leased');

-- Append-only attempt journal: claim and finish are separate records, so
-- crashed processes still leave evidence of the claimed lease.
CREATE TABLE stripe_dispatch_attempts (
  id UUID PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES stripe_webhook_events(event_id)
    ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 6),
  action VARCHAR(16) NOT NULL CHECK (action IN ('claimed','complete','retry','dead')),
  reason VARCHAR(40) NOT NULL CHECK (reason IN (
    'claimed','linked','replayed','applied','unmapped','rejected','skipped',
    'deferred','provider_unavailable','handler_error','lease_expired'
  )),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX stripe_dispatch_attempts_event_idx
  ON stripe_dispatch_attempts(event_id,created_at);

ALTER TABLE stripe_event_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_event_dispatch FORCE ROW LEVEL SECURITY;
ALTER TABLE stripe_dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_dispatch_attempts FORCE ROW LEVEL SECURITY;

-- Only the database's trusted trigger can create a queued record. Trigger
-- SECURITY DEFINER runs with a fixed search path and cannot be called by API.
CREATE FUNCTION public.enqueue_signed_stripe_test_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $func$
BEGIN
  IF NEW.livemode<>FALSE OR NEW.status<>'received' THEN
    RAISE EXCEPTION 'Unexpected Stripe inbox state';
  END IF;
  INSERT INTO public.stripe_event_dispatch(event_id,event_type)
    VALUES (NEW.event_id,NEW.event_type);
  RETURN NEW;
END
$func$;
REVOKE ALL ON FUNCTION public.enqueue_signed_stripe_test_event() FROM PUBLIC;
CREATE TRIGGER enqueue_stripe_test_event
  AFTER INSERT ON stripe_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_signed_stripe_test_event();

-- Preserve already-signed events accepted in preceding schema versions.
INSERT INTO stripe_event_dispatch(event_id,event_type)
  SELECT event_id,event_type FROM stripe_webhook_events;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='melissa_billing_dispatcher') THEN
    CREATE ROLE melissa_billing_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$role$;
GRANT USAGE ON SCHEMA public TO melissa_billing_dispatcher;

CREATE POLICY stripe_dispatcher_read ON stripe_event_dispatch
  FOR SELECT TO melissa_billing_dispatcher USING (TRUE);
CREATE POLICY stripe_dispatcher_update ON stripe_event_dispatch
  FOR UPDATE TO melissa_billing_dispatcher USING (TRUE) WITH CHECK (TRUE);
GRANT SELECT (event_id,event_type,state,attempts,next_attempt_at,
              lease_token,lease_until,last_reason)
  ON stripe_event_dispatch TO melissa_billing_dispatcher;
GRANT UPDATE (state,attempts,next_attempt_at,lease_token,lease_until,
              last_reason,updated_at)
  ON stripe_event_dispatch TO melissa_billing_dispatcher;

CREATE POLICY stripe_dispatch_attempts_read ON stripe_dispatch_attempts
  FOR SELECT TO melissa_billing_dispatcher USING (TRUE);
CREATE POLICY stripe_dispatch_attempts_insert ON stripe_dispatch_attempts
  FOR INSERT TO melissa_billing_dispatcher WITH CHECK (TRUE);
GRANT SELECT (id,event_id,attempt,action,reason,created_at)
  ON stripe_dispatch_attempts TO melissa_billing_dispatcher;
GRANT INSERT (id,event_id,attempt,action,reason)
  ON stripe_dispatch_attempts TO melissa_billing_dispatcher;

-- Billing dispatcher cannot access webhook payloads, Stripe credentials,
-- subscriptions or tenants. Linking and reconciling still require different
-- non-inheritable, separately provisioned restricted PostgreSQL roles.
UPDATE infrastructure_metadata SET value='69' WHERE key='schema_version';
COMMIT;
