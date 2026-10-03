BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE booking_calendar_events
  ADD COLUMN reconcile_lease_id UUID,
  ADD COLUMN reconcile_lease_until TIMESTAMPTZ(6);

ALTER TABLE booking_calendar_events
  ADD CONSTRAINT booking_calendar_events_reconcile_lease_pair_check
  CHECK (
    (reconcile_lease_id IS NULL AND reconcile_lease_until IS NULL)
    OR (reconcile_lease_id IS NOT NULL AND reconcile_lease_until IS NOT NULL)
  );

CREATE INDEX booking_calendar_events_reconcile_due_idx
  ON booking_calendar_events (reconciled_at, tenant_id, booking_id)
  WHERE reconcile_lease_until IS NULL;

GRANT UPDATE (
  reconcile_lease_id, reconcile_lease_until
) ON booking_calendar_events TO melissa_runtime;

UPDATE infrastructure_metadata SET value='45' WHERE key='schema_version';
COMMIT;
