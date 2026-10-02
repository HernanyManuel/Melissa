BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_outbox
  ADD COLUMN state VARCHAR(24) NOT NULL DEFAULT 'pending',
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN processed_at TIMESTAMPTZ(6),
  ADD CONSTRAINT booking_outbox_state_check
    CHECK (state IN ('pending', 'processed', 'rejected', 'failed')),
  ADD CONSTRAINT booking_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  ADD CONSTRAINT booking_outbox_pending_attempts_check
    CHECK (state <> 'pending' OR attempts < 5),
  ADD CONSTRAINT booking_outbox_processed_at_check
    CHECK ((state = 'processed') = (processed_at IS NOT NULL));

CREATE INDEX booking_outbox_due_idx
  ON booking_outbox(state, next_attempt_at, id);

GRANT UPDATE (state, attempts, next_attempt_at, processed_at)
  ON booking_outbox TO melissa_runtime;

UPDATE infrastructure_metadata SET value='42' WHERE key='schema_version';
COMMIT;
