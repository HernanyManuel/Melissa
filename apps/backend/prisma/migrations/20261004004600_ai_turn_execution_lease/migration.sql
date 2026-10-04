BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE ai_turns
  ADD COLUMN execution_lease_id UUID,
  ADD COLUMN execution_lease_expires_at TIMESTAMPTZ(6);

ALTER TABLE ai_turns
  ADD CONSTRAINT ai_turns_execution_lease_pair_check
  CHECK (
    (execution_lease_id IS NULL AND execution_lease_expires_at IS NULL)
    OR (execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL)
  );

CREATE INDEX ai_turns_execution_lease_idx
  ON ai_turns (execution_lease_expires_at, tenant_id, id)
  WHERE status = 'running';

GRANT INSERT (execution_lease_id, execution_lease_expires_at) ON ai_turns TO melissa_runtime;
GRANT UPDATE (execution_lease_id, execution_lease_expires_at) ON ai_turns TO melissa_runtime;

UPDATE infrastructure_metadata SET value='46' WHERE key='schema_version';
COMMIT;
