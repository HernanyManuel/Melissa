CREATE TABLE customers (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id UUID NOT NULL,
  display_name VARCHAR(160) NOT NULL CHECK (length(trim(display_name)) > 0),
  phone_e164 VARCHAR(16) NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email VARCHAR(254),
  language VARCHAR(12) NOT NULL DEFAULT 'pt',
  notes VARCHAR(4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,phone_e164)
);
CREATE INDEX customers_tenant_deleted_id_idx ON customers(tenant_id,deleted_at,id);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON customers TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON customers TO melissa_runtime;
