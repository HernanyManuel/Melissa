-- Minimal internal routing registry. Only trusted provisioning may write bindings.
CREATE TABLE whatsapp_routes (
  integration_key VARCHAR(128) NOT NULL,
  account_id VARCHAR(32) NOT NULL CHECK(account_id ~ '^[0-9]{1,32}$'),
  phone_id VARCHAR(32) NOT NULL CHECK(phone_id ~ '^[0-9]{1,32}$'),
  tenant_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  PRIMARY KEY(integration_key,account_id,phone_id),
  UNIQUE(tenant_id,channel_id),
  FOREIGN KEY(tenant_id,channel_id) REFERENCES channel_connections(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE whatsapp_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_routing_read ON whatsapp_routes FOR SELECT TO melissa_runtime USING(true);
GRANT SELECT ON whatsapp_routes TO melissa_runtime;
-- No runtime INSERT/UPDATE/DELETE privileges or policies. No public API exposes this registry.
UPDATE infrastructure_metadata SET value='9' WHERE key='schema_version';
