BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_outbox
  ADD COLUMN processed_at TIMESTAMPTZ(6),
  DROP CONSTRAINT booking_outbox_attempts_check,
  ADD CONSTRAINT booking_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT booking_outbox_pending_attempts_check
    CHECK (state <> 'pending' OR attempts < 5),
  ADD CONSTRAINT booking_outbox_processed_at_check
    CHECK ((state = 'processed') = (processed_at IS NOT NULL));

GRANT UPDATE (state, attempts, next_attempt_at, processed_at)
  ON booking_outbox TO melissa_runtime;

UPDATE infrastructure_metadata SET value='42' WHERE key='schema_version';
COMMIT;
