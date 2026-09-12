BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE calendar_connections (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  staff_id UUID,
  provider VARCHAR(24) NOT NULL CHECK (provider IN ('mock', 'google')),
  calendar_ref VARCHAR(512) NOT NULL CHECK (length(trim(calendar_ref)) BETWEEN 1 AND 512),
  credential_ref TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'disconnected', 'reauth_required')),
  sync_token TEXT,
  sync_version BIGINT NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  last_success_at TIMESTAMPTZ(6),
  freshness_limit_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (freshness_limit_seconds BETWEEN 1 AND 86400),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT calendar_connections_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT calendar_connections_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT calendar_connections_staff_fkey FOREIGN KEY (tenant_id, staff_id)
    REFERENCES staff(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_connections_provider_calendar_key
    UNIQUE (tenant_id, provider, calendar_ref),
  CONSTRAINT calendar_connections_credential_ref_check
    CHECK (credential_ref IS NULL OR length(trim(credential_ref)) > 0),
  CONSTRAINT calendar_connections_google_credential_check
    CHECK (provider <> 'google' OR credential_ref IS NOT NULL)
);

CREATE INDEX calendar_connections_tenant_status_id_idx
  ON calendar_connections (tenant_id, status, id);
CREATE INDEX calendar_connections_tenant_staff_status_idx
  ON calendar_connections (tenant_id, staff_id, status, id);

CREATE TABLE calendar_busy_intervals (
  tenant_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  id UUID NOT NULL,
  starts_at TIMESTAMPTZ(6) NOT NULL,
  ends_at TIMESTAMPTZ(6) NOT NULL,
  sync_version BIGINT NOT NULL CHECK (sync_version >= 0),
  observed_at TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT calendar_busy_intervals_pkey PRIMARY KEY (tenant_id, connection_id, id),
  CONSTRAINT calendar_busy_intervals_connection_fkey
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES calendar_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_busy_intervals_range_check CHECK (ends_at > starts_at)
);

CREATE INDEX calendar_busy_intervals_lookup_idx
  ON calendar_busy_intervals (tenant_id, connection_id, starts_at, ends_at);

GRANT SELECT, INSERT, UPDATE ON calendar_connections TO melissa_runtime;
GRANT SELECT, INSERT, DELETE ON calendar_busy_intervals TO melissa_runtime;

ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_connections_tenant_scope ON calendar_connections TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE calendar_busy_intervals ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_busy_intervals FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_busy_intervals_tenant_scope ON calendar_busy_intervals TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

UPDATE infrastructure_metadata SET value='37' WHERE key='schema_version';
COMMIT;
