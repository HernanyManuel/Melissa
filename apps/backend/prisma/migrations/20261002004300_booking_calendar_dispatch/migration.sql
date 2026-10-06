BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE booking_calendar_dispatch (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_calendar_dispatch_outbox_fkey FOREIGN KEY (tenant_id, id)
    REFERENCES booking_outbox(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_calendar_dispatch_state_check
    CHECK (state IN ('pending', 'processed', 'failed')),
  CONSTRAINT booking_calendar_dispatch_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT booking_calendar_dispatch_pending_attempts_check
    CHECK (state <> 'pending' OR attempts < 5)
);

CREATE INDEX booking_calendar_dispatch_due_idx
  ON booking_calendar_dispatch(state, next_attempt_at, id);

ALTER TABLE booking_calendar_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_calendar_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_calendar_dispatch_discovery
  ON booking_calendar_dispatch FOR SELECT TO melissa_runtime USING (true);
CREATE POLICY booking_calendar_dispatch_insert
  ON booking_calendar_dispatch FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));
CREATE POLICY booking_calendar_dispatch_update
  ON booking_calendar_dispatch FOR UPDATE TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON booking_calendar_dispatch TO melissa_runtime;
GRANT INSERT (id, tenant_id) ON booking_calendar_dispatch TO melissa_runtime;
GRANT UPDATE (state, attempts, next_attempt_at) ON booking_calendar_dispatch TO melissa_runtime;

INSERT INTO booking_calendar_dispatch (id, tenant_id)
SELECT id, tenant_id
FROM booking_outbox
WHERE state='pending'
ON CONFLICT (id) DO NOTHING;

UPDATE infrastructure_metadata SET value='43' WHERE key='schema_version';
COMMIT;
