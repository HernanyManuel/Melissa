CREATE TABLE channel_connections (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL,
  channel_type VARCHAR(24) NOT NULL CHECK (channel_type IN ('whatsapp','webchat')),
  mode VARCHAR(12) NOT NULL CHECK (mode IN ('mock','live')),
  external_account_id VARCHAR(160) NOT NULL,
  external_phone_id VARCHAR(160) NOT NULL,
  display_name VARCHAR(160) NOT NULL CHECK (length(trim(display_name)) > 0),
  status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected')),
  credentials_reference TEXT,
  webhook_secret_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (mode,channel_type,external_phone_id),
  CHECK ((status='active' AND disconnected_at IS NULL) OR (status='disconnected' AND disconnected_at IS NOT NULL)),
  CHECK (mode<>'mock' OR (external_account_id LIKE 'mock:%' AND external_phone_id LIKE 'mock:%' AND credentials_reference IS NULL AND webhook_secret_reference IS NULL)),
  CHECK (mode<>'live' OR (credentials_reference IS NOT NULL AND webhook_secret_reference IS NOT NULL))
);
CREATE INDEX channel_connections_tenant_status_id_idx ON channel_connections(tenant_id,status,id);
ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON channel_connections TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON channel_connections TO melissa_runtime;
UPDATE infrastructure_metadata SET value='5' WHERE key='schema_version';
