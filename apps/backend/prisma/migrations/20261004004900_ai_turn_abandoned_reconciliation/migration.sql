BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX ai_turns_abandoned_reconciliation_idx
  ON ai_turns (execution_lease_expires_at, tenant_id, id)
  WHERE status='running' AND execution_lease_id IS NOT NULL;

GRANT UPDATE (status, failure_code, completed_at, execution_lease_id, execution_lease_expires_at)
  ON ai_turns TO melissa_runtime;

UPDATE infrastructure_metadata SET value='49' WHERE key='schema_version';
COMMIT;
