BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE ai_outbound_delivery_receipts (
  tenant_id UUID NOT NULL,
  provider_message_id VARCHAR(512) NOT NULL,
  status VARCHAR(24) NOT NULL,
  status_rank SMALLINT NOT NULL,
  provider_timestamp TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_outbound_delivery_receipts_pkey
    PRIMARY KEY (tenant_id, provider_message_id),
  CONSTRAINT ai_outbound_delivery_receipts_dispatch_fkey
    FOREIGN KEY (tenant_id, provider_message_id)
    REFERENCES ai_outbound_dispatch(tenant_id, provider_message_id)
    ON DELETE CASCADE,
  CONSTRAINT ai_outbound_delivery_receipts_status_check
    CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  CONSTRAINT ai_outbound_delivery_receipts_rank_check
    CHECK (
      (status='sent' AND status_rank=10)
      OR (status='delivered' AND status_rank=20)
      OR (status='read' AND status_rank=30)
      OR (status='failed' AND status_rank=40)
    )
);

ALTER TABLE ai_outbound_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_outbound_delivery_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_outbound_delivery_receipts_tenant_scope
  ON ai_outbound_delivery_receipts TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON ai_outbound_delivery_receipts TO melissa_runtime;
GRANT INSERT (tenant_id, provider_message_id, status, status_rank, provider_timestamp)
  ON ai_outbound_delivery_receipts TO melissa_runtime;
GRANT UPDATE (status, status_rank, provider_timestamp, updated_at)
  ON ai_outbound_delivery_receipts TO melissa_runtime;

UPDATE infrastructure_metadata SET value='52' WHERE key='schema_version';
COMMIT;
