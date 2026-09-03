BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Immutable intent, not a delivery receipt. No dispatcher consumes this table yet.
CREATE TABLE outbound_intents (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  actor_id UUID NOT NULL,
  request_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  provider_key TEXT NOT NULL DEFAULT 'mock' CHECK (provider_key = 'mock'),
  content_text VARCHAR(4096) NOT NULL CHECK (length(btrim(content_text)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id),
  UNIQUE (tenant_id, actor_id, request_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX outbound_intents_conversation_idx
  ON outbound_intents (tenant_id, conversation_id, created_at, id);
ALTER TABLE outbound_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON outbound_intents TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT ON outbound_intents TO melissa_runtime;
-- No UPDATE/DELETE grants: payload and idempotency identity cannot drift on retry.
UPDATE infrastructure_metadata SET value='16' WHERE key='schema_version';
COMMIT;
