BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Retain the idempotency key and audit evidence. Abandonment applies only
-- to non-dispatched preparations; the application rejects any existing dispatch.
ALTER TABLE human_outbound_intents
  ADD COLUMN abandoned_at TIMESTAMPTZ(6);

-- The runtime may only change the lifecycle flag, never alter text, actor,
-- requestId, conversation or the original mode epoch.
GRANT UPDATE (abandoned_at) ON human_outbound_intents TO melissa_runtime;

UPDATE infrastructure_metadata SET value='57' WHERE key='schema_version';
COMMIT;
