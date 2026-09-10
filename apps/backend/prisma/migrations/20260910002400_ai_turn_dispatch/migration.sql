BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_turn_intents (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  mode_epoch BIGINT NOT NULL,
  state_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_turn_intents_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_turn_intents_id_key UNIQUE (id),
  CONSTRAINT ai_turn_intents_batch_key UNIQUE (tenant_id, batch_id),
  CONSTRAINT ai_turn_intents_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_turn_intents_batch_fkey FOREIGN KEY (tenant_id, batch_id)
    REFERENCES inbound_batches(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_turn_intents_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_turn_intents_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_turn_intents_mode_epoch_check CHECK (mode_epoch >= 0),
  CONSTRAINT ai_turn_intents_state_version_check CHECK (state_version >= 0)
);

CREATE INDEX ai_turn_intents_conversation_idx
  ON ai_turn_intents(tenant_id, conversation_id, created_at, id);

CREATE TABLE ai_turn_dispatch (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_turn_dispatch_intent_fkey FOREIGN KEY (tenant_id, id)
    REFERENCES ai_turn_intents(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_turn_dispatch_state_check
    CHECK (state IN ('pending', 'processed', 'rejected', 'failed')),
  CONSTRAINT ai_turn_dispatch_attempts_check CHECK (attempts BETWEEN 0 AND 5)
);

CREATE INDEX ai_turn_dispatch_due_idx
  ON ai_turn_dispatch(state, next_attempt_at, id);

ALTER TABLE ai_turn_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_turn_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_turn_intents_tenant_scope ON ai_turn_intents TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

ALTER TABLE ai_turn_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_turn_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_turn_dispatch_discovery ON ai_turn_dispatch FOR SELECT TO melissa_runtime
  USING (true);
CREATE POLICY ai_turn_dispatch_insert ON ai_turn_dispatch FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));
CREATE POLICY ai_turn_dispatch_update ON ai_turn_dispatch FOR UPDATE TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON ai_turn_intents TO melissa_runtime;
GRANT INSERT
  (tenant_id, id, batch_id, conversation_id, customer_id, mode_epoch, state_version)
  ON ai_turn_intents TO melissa_runtime;
GRANT SELECT ON ai_turn_dispatch TO melissa_runtime;
GRANT INSERT (tenant_id, id) ON ai_turn_dispatch TO melissa_runtime;
GRANT UPDATE (state, attempts, next_attempt_at) ON ai_turn_dispatch TO melissa_runtime;

UPDATE infrastructure_metadata SET value='24' WHERE key='schema_version';
COMMIT;
