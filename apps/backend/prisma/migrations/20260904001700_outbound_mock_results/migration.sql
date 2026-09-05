BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE outbound_mock_results (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('mock_accepted', 'rejected')),
  provider_message_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, id) REFERENCES outbound_intents(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'mock_accepted' AND provider_message_id IS NOT NULL AND provider_message_id = 'mock:' || id::text)
    OR (state = 'rejected' AND provider_message_id IS NULL)
  )
);
ALTER TABLE outbound_mock_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_mock_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON outbound_mock_results TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT ON outbound_mock_results TO melissa_runtime;
UPDATE infrastructure_metadata SET value='17' WHERE key='schema_version';
COMMIT;
