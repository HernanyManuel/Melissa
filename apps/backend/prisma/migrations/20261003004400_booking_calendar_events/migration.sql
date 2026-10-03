BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE booking_calendar_events (
  tenant_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  external_event_id VARCHAR(512) NOT NULL,
  external_version VARCHAR(1024) NOT NULL,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  booking_version INTEGER NOT NULL,
  reconciled_at TIMESTAMPTZ(6) NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, connection_id, booking_id),
  CONSTRAINT booking_calendar_events_connection_fkey
    FOREIGN KEY (tenant_id, connection_id)
    REFERENCES calendar_connections(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_calendar_events_booking_fkey
    FOREIGN KEY (tenant_id, booking_id)
    REFERENCES bookings(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_calendar_events_booking_version_check CHECK (booking_version >= 1)
);

ALTER TABLE booking_calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_calendar_events FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_calendar_events_tenant
  ON booking_calendar_events FOR ALL TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON booking_calendar_events TO melissa_runtime;
GRANT INSERT (
  tenant_id, connection_id, booking_id, external_event_id, external_version,
  cancelled, booking_version, reconciled_at
) ON booking_calendar_events TO melissa_runtime;
GRANT UPDATE (
  external_event_id, external_version, cancelled, booking_version, reconciled_at, updated_at
) ON booking_calendar_events TO melissa_runtime;

UPDATE infrastructure_metadata SET value='44' WHERE key='schema_version';
COMMIT;
