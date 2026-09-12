BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_outbox
  DROP CONSTRAINT booking_outbox_booking_event_key;

CREATE UNIQUE INDEX booking_outbox_singleton_event_key
  ON booking_outbox(tenant_id, booking_id, event_type)
  WHERE event_type IN ('created', 'cancelled');

UPDATE infrastructure_metadata SET value='32' WHERE key='schema_version';
COMMIT;
