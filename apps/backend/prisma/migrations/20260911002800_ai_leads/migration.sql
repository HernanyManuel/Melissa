BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE leads (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(200) NOT NULL,
  conversation_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  turn_id UUID NOT NULL,
  arguments_hash CHAR(64) NOT NULL,
  topic VARCHAR(120) NOT NULL,
  details VARCHAR(1000) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT leads_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT leads_id_key UNIQUE (id),
  CONSTRAINT leads_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT leads_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT leads_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT leads_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT leads_turn_fkey FOREIGN KEY (tenant_id, turn_id)
    REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT leads_arguments_hash_check CHECK (arguments_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT leads_topic_nonempty_check CHECK (length(btrim(topic)) > 0),
  CONSTRAINT leads_details_nonempty_check CHECK (length(btrim(details)) > 0),
  CONSTRAINT leads_status_check CHECK (status = 'new')
);

CREATE INDEX leads_customer_idx
  ON leads(tenant_id, customer_id, created_at, id);
CREATE INDEX leads_conversation_idx
  ON leads(tenant_id, conversation_id, created_at, id);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY leads_tenant_scope ON leads TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON leads TO melissa_runtime;
GRANT INSERT
  (tenant_id, idempotency_key, conversation_id, customer_id, turn_id, arguments_hash, topic, details)
  ON leads TO melissa_runtime;

UPDATE infrastructure_metadata SET value='28' WHERE key='schema_version';
COMMIT;
