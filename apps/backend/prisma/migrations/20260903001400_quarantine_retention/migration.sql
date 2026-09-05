-- Minimal expiry routing survives removal of WhatsApp channel bindings.
ALTER TABLE whatsapp_quarantine ADD CONSTRAINT quarantine_expiry_identity UNIQUE(tenant_id,id,expires_at);
CREATE TABLE quarantine_expiry (
  tenant_id UUID NOT NULL, id UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,id,expires_at) REFERENCES whatsapp_quarantine(tenant_id,id,expires_at)
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX quarantine_expiry_due_idx ON quarantine_expiry(expires_at,tenant_id,id);
INSERT INTO quarantine_expiry(tenant_id,id,expires_at)
  SELECT tenant_id,id,expires_at FROM whatsapp_quarantine;
ALTER TABLE quarantine_expiry ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_expiry FORCE ROW LEVEL SECURITY;
CREATE POLICY expiry_routing_read ON quarantine_expiry FOR SELECT TO melissa_runtime USING(true);
CREATE POLICY expiry_routing_insert ON quarantine_expiry FOR INSERT TO melissa_runtime
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON quarantine_expiry TO melissa_runtime;
UPDATE infrastructure_metadata SET value='14' WHERE key='schema_version';
