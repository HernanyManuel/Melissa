BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_handoff_requests (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(200) NOT NULL,
  conversation_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  turn_id UUID NOT NULL,
  reason VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_handoff_requests_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_handoff_requests_id_key UNIQUE (id),
  CONSTRAINT ai_handoff_requests_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ai_handoff_requests_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_handoff_requests_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_handoff_requests_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_handoff_requests_turn_fkey FOREIGN KEY (tenant_id, turn_id)
    REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_handoff_requests_reason_check CHECK (
    reason IN ('customer_requested', 'unsupported', 'complaint', 'safety', 'other')
  )
);

CREATE INDEX ai_handoff_requests_conversation_idx
  ON ai_handoff_requests(tenant_id, conversation_id, created_at, id);

ALTER TABLE ai_handoff_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_handoff_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_handoff_requests_tenant_scope ON ai_handoff_requests TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON ai_handoff_requests TO melissa_runtime;
GRANT INSERT
  (tenant_id, idempotency_key, conversation_id, customer_id, turn_id, reason)
  ON ai_handoff_requests TO melissa_runtime;

UPDATE infrastructure_metadata SET value='26' WHERE key='schema_version';
COMMIT;
