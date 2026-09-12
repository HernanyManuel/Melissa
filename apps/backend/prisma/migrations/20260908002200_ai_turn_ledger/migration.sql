BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_turns (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  mode_epoch BIGINT NOT NULL,
  state_version BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'running',
  rounds INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  failure_code VARCHAR(64),
  started_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(6),
  CONSTRAINT ai_turns_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_turns_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_turns_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_turns_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_turns_versions_check CHECK (mode_epoch >= 0 AND state_version >= 0),
  CONSTRAINT ai_turns_bounds_check CHECK (rounds BETWEEN 0 AND 4 AND tool_calls BETWEEN 0 AND 8),
  CONSTRAINT ai_turns_status_check CHECK (status IN ('running', 'completed', 'handoff_required', 'failed', 'stale')),
  CONSTRAINT ai_turns_completion_check CHECK (
    (status = 'running' AND completed_at IS NULL AND rounds = 0 AND tool_calls = 0 AND failure_code IS NULL)
    OR
    (status IN ('completed', 'handoff_required') AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR
    (status IN ('failed', 'stale') AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX ai_turns_conversation_started_idx
  ON ai_turns(tenant_id, conversation_id, started_at, id);

CREATE TABLE ai_usage_events (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  turn_id UUID NOT NULL,
  provider_key VARCHAR(64) NOT NULL,
  model_key VARCHAR(128) NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  outcome VARCHAR(24) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_usage_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_usage_events_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_events_turn_fkey FOREIGN KEY (tenant_id, turn_id)
    REFERENCES ai_turns(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_events_turn_key UNIQUE (tenant_id, turn_id),
  CONSTRAINT ai_usage_events_tokens_check CHECK (
    input_tokens BETWEEN 0 AND 100000000 AND output_tokens BETWEEN 0 AND 100000000
  ),
  CONSTRAINT ai_usage_events_outcome_check CHECK (outcome IN ('completed', 'handoff_required', 'failed', 'stale')),
  CONSTRAINT ai_usage_events_provider_check CHECK (
    provider_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    AND model_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  )
);

CREATE INDEX ai_usage_events_created_idx ON ai_usage_events(tenant_id, created_at, id);

ALTER TABLE ai_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_turns_tenant_policy ON ai_turns TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_events_tenant_policy ON ai_usage_events TO melissa_runtime
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));

GRANT SELECT ON ai_turns TO melissa_runtime;
GRANT INSERT (tenant_id, id, conversation_id, customer_id, mode_epoch, state_version)
  ON ai_turns TO melissa_runtime;
GRANT UPDATE (status, rounds, tool_calls, failure_code, completed_at) ON ai_turns TO melissa_runtime;
GRANT SELECT ON ai_usage_events TO melissa_runtime;
GRANT INSERT (tenant_id, id, turn_id, provider_key, model_key, input_tokens, output_tokens, outcome)
  ON ai_usage_events TO melissa_runtime;

UPDATE infrastructure_metadata SET value='22' WHERE key='schema_version';
COMMIT;
