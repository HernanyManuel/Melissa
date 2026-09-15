BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_policies
  ADD COLUMN creation_min_notice_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN creation_max_horizon_days INTEGER;

ALTER TABLE booking_policies
  ADD CONSTRAINT booking_policies_creation_notice_check
    CHECK (creation_min_notice_minutes BETWEEN 0 AND 525600),
  ADD CONSTRAINT booking_policies_creation_horizon_check
    CHECK (creation_max_horizon_days IS NULL OR creation_max_horizon_days BETWEEN 0 AND 3650);

UPDATE infrastructure_metadata SET value='36' WHERE key='schema_version';
COMMIT;
