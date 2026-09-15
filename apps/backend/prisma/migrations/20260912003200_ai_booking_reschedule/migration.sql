BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_operations
  ADD COLUMN result_starts_at TIMESTAMPTZ(6),
  ADD COLUMN result_ends_at TIMESTAMPTZ(6),
  ADD COLUMN result_timezone VARCHAR(80),
  ADD CONSTRAINT booking_operations_result_check CHECK (
    (operation='reschedule' AND result_starts_at IS NOT NULL AND result_ends_at IS NOT NULL AND
      result_timezone IS NOT NULL AND result_ends_at > result_starts_at) OR
    (operation<>'reschedule' AND result_starts_at IS NULL AND result_ends_at IS NULL AND
      result_timezone IS NULL)
  );

ALTER TABLE booking_outbox
  DROP CONSTRAINT booking_outbox_booking_event_key;

CREATE UNIQUE INDEX booking_outbox_singleton_event_key
  ON booking_outbox(tenant_id, booking_id, event_type)
  WHERE event_type IN ('created', 'cancelled');

UPDATE infrastructure_metadata SET value='32' WHERE key='schema_version';
COMMIT;
