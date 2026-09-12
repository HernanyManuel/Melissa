BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE calendar_credentials (
  tenant_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  key_id VARCHAR(64) NOT NULL,
  nonce BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  tag BYTEA NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT calendar_credentials_pkey PRIMARY KEY (tenant_id, connection_id),
  CONSTRAINT calendar_credentials_connection_fkey
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES calendar_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_credentials_key_id_check
    CHECK (key_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT calendar_credentials_nonce_check CHECK (octet_length(nonce) = 12),
  CONSTRAINT calendar_credentials_tag_check CHECK (octet_length(tag) = 16),
  CONSTRAINT calendar_credentials_ciphertext_check
    CHECK (octet_length(ciphertext) BETWEEN 1 AND 16384)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_credentials TO melissa_runtime;
ALTER TABLE calendar_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_credentials_tenant_scope ON calendar_credentials TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

UPDATE infrastructure_metadata SET value='40' WHERE key='schema_version';
COMMIT;
