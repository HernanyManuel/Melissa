BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_outbox ADD COLUMN booking_version INTEGER;

UPDATE booking_outbox outbox
SET booking_version=booking.version
FROM bookings booking
WHERE booking.tenant_id=outbox.tenant_id AND booking.id=outbox.booking_id;

ALTER TABLE booking_outbox
  ALTER COLUMN booking_version SET NOT NULL,
  ADD CONSTRAINT booking_outbox_version_check CHECK (booking_version > 0);

CREATE UNIQUE INDEX booking_outbox_event_version_key
  ON booking_outbox(tenant_id, booking_id, event_type, booking_version);

UPDATE infrastructure_metadata SET value='41' WHERE key='schema_version';
COMMIT;
