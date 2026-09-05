BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- Global discovery exposes only routing/lifecycle metadata, never message content.
CREATE TABLE outbound_dispatch (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','mock_accepted','rejected','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,id) REFERENCES outbound_intents(tenant_id,id) ON DELETE RESTRICT,
  CHECK (state <> 'pending' OR attempts < 5)
);
CREATE INDEX outbound_dispatch_due_idx ON outbound_dispatch(state,next_attempt_at,id);
ALTER TABLE outbound_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery ON outbound_dispatch FOR SELECT TO melissa_runtime USING (true);
CREATE POLICY scoped_insert ON outbound_dispatch FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY scoped_update ON outbound_dispatch FOR UPDATE TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT, INSERT ON outbound_dispatch TO melissa_runtime;
GRANT UPDATE(state,attempts,next_attempt_at) ON outbound_dispatch TO melissa_runtime;
-- Deliberately no backfill: previously stored-only intents are not silently activated.
UPDATE infrastructure_metadata SET value='18' WHERE key='schema_version';
COMMIT;
