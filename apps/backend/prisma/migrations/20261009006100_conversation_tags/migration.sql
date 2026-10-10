BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE conversation_tags (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  name VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK (length(btrim(name)) > 0)
);
CREATE TABLE conversation_tag_links (
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, conversation_id, tag_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, tag_id) REFERENCES conversation_tags(tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES memberships(tenant_id, user_id)
    ON DELETE RESTRICT
);
CREATE INDEX conversation_tag_links_tag_idx ON conversation_tag_links(tenant_id, tag_id);
ALTER TABLE conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_tags_tenant ON conversation_tags TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));
ALTER TABLE conversation_tag_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_tag_links FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_tag_links_tenant ON conversation_tag_links TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true)
    AND actor_id::text=current_setting('app.actor_id', true));
GRANT SELECT ON conversation_tags, conversation_tag_links TO melissa_runtime;
GRANT INSERT (tenant_id, id, name, created_at) ON conversation_tags TO melissa_runtime;
GRANT INSERT (tenant_id, conversation_id, tag_id, actor_id, created_at)
  ON conversation_tag_links TO melissa_runtime;
GRANT DELETE ON conversation_tag_links TO melissa_runtime;
-- No tag rename/delete: catalog labels remain stable across audits.
UPDATE infrastructure_metadata SET value='61' WHERE key='schema_version';
COMMIT;
