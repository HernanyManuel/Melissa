BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Minimal discovery envelope: no media ID, MIME, URL, phone, payload or credentials.
CREATE TABLE media_ingestion_dispatch (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'quarantined' CHECK (state = 'quarantined'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (id),
  FOREIGN KEY (tenant_id,id) REFERENCES whatsapp_quarantine(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX media_ingestion_dispatch_state_idx
  ON media_ingestion_dispatch(state,created_at,id);
ALTER TABLE media_ingestion_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_ingestion_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY media_dispatch_discovery ON media_ingestion_dispatch FOR SELECT TO melissa_runtime
  USING (true);
CREATE POLICY media_dispatch_insert ON media_ingestion_dispatch FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON media_ingestion_dispatch TO melissa_runtime;
-- No backfill: historical ciphertext is not decrypted or activated during migration.
UPDATE infrastructure_metadata SET value='19' WHERE key='schema_version';
COMMIT;
