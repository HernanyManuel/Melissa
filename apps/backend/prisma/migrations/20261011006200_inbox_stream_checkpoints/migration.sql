BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Durable, actor-owned SSE replay checkpoint, distinct from read receipts.
-- Only a cursor whose event exists in this tenant can be acknowledged.
CREATE TABLE inbox_stream_checkpoints (
  tenant_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  last_applied_sequence BIGINT NOT NULL CHECK (last_applied_sequence > 0),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inbox_stream_checkpoints_pkey PRIMARY KEY (tenant_id, actor_id),
  CONSTRAINT inbox_stream_checkpoints_membership_fk FOREIGN KEY (tenant_id, actor_id)
    REFERENCES memberships (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT inbox_stream_checkpoints_event_fk FOREIGN KEY (tenant_id, last_applied_sequence)
    REFERENCES inbox_events (tenant_id, sequence) ON DELETE RESTRICT
);

ALTER TABLE inbox_stream_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_stream_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_stream_checkpoints_actor_scope ON inbox_stream_checkpoints
  TO melissa_runtime
  USING (
    tenant_id::text=current_setting('app.tenant_id', true)
    AND actor_id::text=current_setting('app.actor_id', true)
  )
  WITH CHECK (
    tenant_id::text=current_setting('app.tenant_id', true)
    AND actor_id::text=current_setting('app.actor_id', true)
  );

GRANT SELECT ON inbox_stream_checkpoints TO melissa_runtime;
GRANT INSERT (tenant_id, actor_id, last_applied_sequence, updated_at)
  ON inbox_stream_checkpoints TO melissa_runtime;
GRANT UPDATE (last_applied_sequence, updated_at)
  ON inbox_stream_checkpoints TO melissa_runtime;

UPDATE infrastructure_metadata SET value='62' WHERE key='schema_version';
COMMIT;
