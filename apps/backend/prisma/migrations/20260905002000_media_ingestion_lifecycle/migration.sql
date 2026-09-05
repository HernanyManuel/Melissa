BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE media_ingestion_dispatch
  DROP CONSTRAINT media_ingestion_dispatch_state_check,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN storage_key TEXT,
  ADD COLUMN content_type TEXT,
  ADD COLUMN size_bytes INTEGER,
  ADD COLUMN checksum_sha256 TEXT,
  ADD CONSTRAINT media_ingestion_dispatch_state_check
    CHECK (state IN ('quarantined','stored','failed')),
  ADD CONSTRAINT media_ingestion_dispatch_result_check CHECK (
    (state = 'stored' AND storage_key IS NOT NULL AND content_type IS NOT NULL
      AND size_bytes > 0 AND checksum_sha256 ~ '^[a-f0-9]{64}$')
    OR
    (state <> 'stored' AND storage_key IS NULL AND content_type IS NULL
      AND size_bytes IS NULL AND checksum_sha256 IS NULL)
  ),
  ADD CONSTRAINT media_ingestion_dispatch_failure_check
    CHECK (state <> 'failed' OR attempts = 5);

DROP INDEX media_ingestion_dispatch_state_idx;
CREATE INDEX media_ingestion_dispatch_due_idx
  ON media_ingestion_dispatch(state,next_attempt_at,id);

CREATE POLICY media_dispatch_update ON media_ingestion_dispatch FOR UPDATE TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
GRANT UPDATE (state,attempts,next_attempt_at,storage_key,content_type,size_bytes,checksum_sha256)
  ON media_ingestion_dispatch TO melissa_runtime;

UPDATE infrastructure_metadata SET value='20' WHERE key='schema_version';
COMMIT;
