BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE calendar_connections
  ADD COLUMN coverage_starts_at TIMESTAMPTZ(6),
  ADD COLUMN coverage_ends_at TIMESTAMPTZ(6),
  ADD CONSTRAINT calendar_connections_coverage_pair_check CHECK (
    (coverage_starts_at IS NULL AND coverage_ends_at IS NULL) OR
    (coverage_starts_at IS NOT NULL AND coverage_ends_at IS NOT NULL)
  ),
  ADD CONSTRAINT calendar_connections_coverage_range_check CHECK (
    coverage_starts_at IS NULL OR coverage_ends_at > coverage_starts_at
  );

UPDATE infrastructure_metadata SET value='38' WHERE key='schema_version';
COMMIT;
