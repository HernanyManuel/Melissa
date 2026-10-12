BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Signed Stripe TEST event ingress. This table is global because the event
-- cannot be associated with a tenant until provider IDs are reconciled.
-- No subscription writes and no live-mode events can enter this inbox.
CREATE TABLE stripe_webhook_events (
  event_id VARCHAR(255) PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]+$'),
  event_type VARCHAR(128) NOT NULL CHECK (length(btrim(event_type)) > 0),
  api_version VARCHAR(64),
  provider_created_at TIMESTAMPTZ(6) NOT NULL,
  payload_sha256 VARCHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  livemode BOOLEAN NOT NULL DEFAULT FALSE CHECK (livemode=FALSE),
  status VARCHAR(24) NOT NULL DEFAULT 'received' CHECK (status='received'),
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX stripe_webhook_events_received_idx ON stripe_webhook_events(status,received_at);

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_events_signed_ingress ON stripe_webhook_events
  FOR INSERT TO melissa_runtime WITH CHECK (livemode=FALSE AND status='received');
CREATE POLICY stripe_events_metadata_only ON stripe_webhook_events
  FOR SELECT TO melissa_runtime USING (TRUE);

-- Runtime can persist signed test deliveries and compare idempotency hashes,
-- but not retrieve private Stripe payloads or mutate accepted evidence.
GRANT INSERT (event_id,event_type,api_version,provider_created_at,
  payload_sha256,payload,livemode) ON stripe_webhook_events TO melissa_runtime;
GRANT SELECT (event_id,event_type,payload_sha256) ON stripe_webhook_events TO melissa_runtime;

UPDATE infrastructure_metadata SET value='64' WHERE key='schema_version';
COMMIT;
