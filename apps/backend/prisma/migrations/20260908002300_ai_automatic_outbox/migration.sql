BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_outbound_intents (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  turn_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  channel_connection_id UUID NOT NULL,
  mode_epoch BIGINT NOT NULL,
  content_text VARCHAR(4096) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_outbound_intents_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_outbound_intents_id_key UNIQUE (id),
  CONSTRAINT ai_outbound_intents_turn_key UNIQUE (tenant_id, turn_id),
  CONSTRAINT ai_outbound_intents_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_outbound_intents_turn_fkey FOREIGN KEY (tenant_id, turn_id)
    REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_outbound_intents_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_outbound_intents_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_outbound_intents_channel_fkey FOREIGN KEY (tenant_id, channel_connection_id)
    REFERENCES channel_connections(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_outbound_intents_content_check CHECK (
    length(btrim(content_text)) BETWEEN 1 AND 4096
  ),
  CONSTRAINT ai_outbound_intents_epoch_check CHECK (mode_epoch >= 0)
);

CREATE INDEX ai_outbound_intents_conversation_idx
  ON ai_outbound_intents(tenant_id, conversation_id, created_at, id);

CREATE TABLE ai_outbound_dispatch (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_outbound_dispatch_intent_fkey FOREIGN KEY (tenant_id, id)
    REFERENCES ai_outbound_intents(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_outbound_dispatch_state_check CHECK (state IN ('pending', 'accepted', 'rejected', 'failed')),
  CONSTRAINT ai_outbound_dispatch_attempts_check CHECK (attempts BETWEEN 0 AND 5)
);

CREATE INDEX ai_outbound_dispatch_due_idx
  ON ai_outbound_dispatch(state, next_attempt_at, id);

ALTER TABLE ai_outbound_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_outbound_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_outbound_intents_tenant_scope ON ai_outbound_intents TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

ALTER TABLE ai_outbound_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_outbound_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_outbound_dispatch_discovery ON ai_outbound_dispatch FOR SELECT TO melissa_runtime
  USING (true);
CREATE POLICY ai_outbound_dispatch_insert ON ai_outbound_dispatch FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));
CREATE POLICY ai_outbound_dispatch_update ON ai_outbound_dispatch FOR UPDATE TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON ai_outbound_intents TO melissa_runtime;
GRANT INSERT (tenant_id, id, turn_id, conversation_id, customer_id, channel_connection_id, mode_epoch, content_text)
  ON ai_outbound_intents TO melissa_runtime;
GRANT SELECT ON ai_outbound_dispatch TO melissa_runtime;
GRANT INSERT (tenant_id, id) ON ai_outbound_dispatch TO melissa_runtime;
GRANT UPDATE (state, attempts, next_attempt_at) ON ai_outbound_dispatch TO melissa_runtime;

UPDATE infrastructure_metadata SET value='23' WHERE key='schema_version';
COMMIT;
