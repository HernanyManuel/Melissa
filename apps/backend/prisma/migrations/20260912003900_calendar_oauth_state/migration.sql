BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE calendar_oauth_states (
  state_hash TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  used_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT calendar_oauth_states_state_hash_check CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT calendar_oauth_states_redirect_uri_check CHECK (char_length(redirect_uri) BETWEEN 8 AND 2048),
  CONSTRAINT calendar_oauth_states_pkce_verifier_check CHECK (
    char_length(pkce_verifier) BETWEEN 43 AND 128 AND
    pkce_verifier ~ '^[A-Za-z0-9._~-]+$'
  ),
  CONSTRAINT calendar_oauth_states_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT calendar_oauth_states_user_fkey FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT calendar_oauth_states_session_fkey FOREIGN KEY (session_id)
    REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX calendar_oauth_states_tenant_created_idx
  ON calendar_oauth_states (tenant_id, created_at DESC);
CREATE INDEX calendar_oauth_states_expires_idx
  ON calendar_oauth_states (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_oauth_states TO melissa_runtime;
ALTER TABLE calendar_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_oauth_states FORCE ROW LEVEL SECURITY;

CREATE POLICY calendar_oauth_state_read ON calendar_oauth_states
FOR SELECT TO melissa_runtime USING (
  tenant_id::text=current_setting('app.tenant_id', true)
  OR state_hash=current_setting('app.oauth_state_hash', true)
);
CREATE POLICY calendar_oauth_state_insert ON calendar_oauth_states
FOR INSERT TO melissa_runtime WITH CHECK (
  tenant_id::text=current_setting('app.tenant_id', true)
  AND user_id::text=current_setting('app.actor_id', true)
);
CREATE POLICY calendar_oauth_state_update ON calendar_oauth_states
FOR UPDATE TO melissa_runtime USING (
  tenant_id::text=current_setting('app.tenant_id', true)
  OR state_hash=current_setting('app.oauth_state_hash', true)
) WITH CHECK (
  tenant_id::text=current_setting('app.tenant_id', true)
  OR state_hash=current_setting('app.oauth_state_hash', true)
);
CREATE POLICY calendar_oauth_state_delete ON calendar_oauth_states
FOR DELETE TO melissa_runtime USING (
  tenant_id::text=current_setting('app.tenant_id', true)
  OR state_hash=current_setting('app.oauth_state_hash', true)
);

UPDATE infrastructure_metadata SET value='39' WHERE key='schema_version';
COMMIT;
