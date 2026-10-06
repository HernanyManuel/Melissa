BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE ai_outbound_dispatch
  ADD COLUMN provider_message_id VARCHAR(512),
  ADD COLUMN accepted_at TIMESTAMPTZ(6);

ALTER TABLE ai_outbound_dispatch
  ADD CONSTRAINT ai_outbound_dispatch_receipt_check CHECK (
    (state='accepted' AND provider_message_id IS NOT NULL AND accepted_at IS NOT NULL)
    OR
    (state<>'accepted' AND provider_message_id IS NULL AND accepted_at IS NULL)
  );

CREATE UNIQUE INDEX ai_outbound_dispatch_provider_message_key
  ON ai_outbound_dispatch (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

GRANT UPDATE (provider_message_id, accepted_at)
  ON ai_outbound_dispatch TO melissa_runtime;

UPDATE infrastructure_metadata SET value='51' WHERE key='schema_version';
COMMIT;
