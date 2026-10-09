BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Independent from messages, external events, and all outbound dispatch tables:
-- internal text can never enter either AI or WhatsApp delivery pipelines.
CREATE TABLE conversation_internal_notes (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  request_id UUID NOT NULL,
  content_text VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT conversation_internal_notes_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT conversation_internal_notes_id_key UNIQUE (id),
  CONSTRAINT conversation_internal_notes_request_key UNIQUE (tenant_id, actor_id, request_id),
  CONSTRAINT conversation_internal_notes_conversation_fkey
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_internal_notes_membership_fkey
    FOREIGN KEY (tenant_id, actor_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT conversation_internal_notes_text_check
    CHECK (length(btrim(content_text)) > 0)
);
CREATE INDEX conversation_internal_notes_page_idx
  ON conversation_internal_notes (tenant_id, conversation_id, created_at DESC, id DESC);

ALTER TABLE conversation_internal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_internal_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_internal_notes_tenant_scope
  ON conversation_internal_notes TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (
    tenant_id::text=current_setting('app.tenant_id', true)
    AND actor_id::text=current_setting('app.actor_id', true)
  );

GRANT SELECT ON conversation_internal_notes TO melissa_runtime;
GRANT INSERT (tenant_id, id, conversation_id, actor_id, request_id, content_text)
  ON conversation_internal_notes TO melissa_runtime;
-- Deliberately no UPDATE, DELETE, TRUNCATE, or REFERENCES grants.

UPDATE infrastructure_metadata SET value='60' WHERE key='schema_version';
COMMIT;
