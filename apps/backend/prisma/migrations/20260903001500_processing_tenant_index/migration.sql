BEGIN;
-- Bounded migration for pre-production. A large live table requires a separately
-- reviewed concurrent-index rollout; do not silently block writers indefinitely.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE INDEX inbound_dispatch_tenant_state_id_idx
  ON inbound_dispatch (tenant_id, state, id);
UPDATE infrastructure_metadata SET value='15' WHERE key='schema_version';
COMMIT;
