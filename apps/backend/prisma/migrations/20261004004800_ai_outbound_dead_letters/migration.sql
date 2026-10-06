BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_outbound_dead_letters (
  tenant_id UUID NOT NULL,
  dispatch_id UUID NOT NULL,
  reason VARCHAR(32) NOT NULL,
  attempts INTEGER NOT NULL,
  failed_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dispatch_id),
  CONSTRAINT ai_outbound_dead_letters_reason_check
    CHECK (reason IN ('retry_exhausted', 'delivery_unknown')),
  CONSTRAINT ai_outbound_dead_letters_attempts_check CHECK (attempts > 0),
  CONSTRAINT ai_outbound_dead_letters_dispatch_fk
    FOREIGN KEY (tenant_id, dispatch_id)
    REFERENCES ai_outbound_intents(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX ai_outbound_dead_letters_failed_idx
  ON ai_outbound_dead_letters (failed_at, tenant_id, dispatch_id);

ALTER TABLE ai_outbound_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_outbound_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_outbound_dead_letters_tenant_isolation ON ai_outbound_dead_letters
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON ai_outbound_dead_letters TO melissa_runtime;

UPDATE infrastructure_metadata SET value='48' WHERE key='schema_version';
COMMIT;
