CREATE TABLE whatsapp_quarantine (
  tenant_id UUID NOT NULL, id UUID NOT NULL, channel_id UUID NOT NULL,
  key_id VARCHAR(64) NOT NULL, nonce BYTEA NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext BYTEA NOT NULL, tag BYTEA NOT NULL CHECK(octet_length(tag)=16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,id) REFERENCES external_events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,channel_id) REFERENCES channel_connections(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX whatsapp_quarantine_expiry_idx ON whatsapp_quarantine(tenant_id,expires_at);
ALTER TABLE whatsapp_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY quarantine_read ON whatsapp_quarantine FOR SELECT TO melissa_runtime
  USING(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY quarantine_insert ON whatsapp_quarantine FOR INSERT TO melissa_runtime
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY quarantine_expired_delete ON whatsapp_quarantine FOR DELETE TO melissa_runtime
  USING(tenant_id::text=current_setting('app.tenant_id',true) AND expires_at < now());
GRANT SELECT,INSERT,DELETE ON whatsapp_quarantine TO melissa_runtime;
UPDATE infrastructure_metadata SET value='13' WHERE key='schema_version';
