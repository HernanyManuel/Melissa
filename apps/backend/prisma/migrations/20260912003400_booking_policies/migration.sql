BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE booking_policies (
  tenant_id UUID NOT NULL,
  cancellation_enabled BOOLEAN NOT NULL DEFAULT true,
  cancellation_min_notice_minutes INTEGER NOT NULL DEFAULT 0,
  rescheduling_enabled BOOLEAN NOT NULL DEFAULT true,
  rescheduling_min_notice_minutes INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_policies_pkey PRIMARY KEY (tenant_id),
  CONSTRAINT booking_policies_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT booking_policies_cancel_notice_check
    CHECK (cancellation_min_notice_minutes BETWEEN 0 AND 525600),
  CONSTRAINT booking_policies_reschedule_notice_check
    CHECK (rescheduling_min_notice_minutes BETWEEN 0 AND 525600),
  CONSTRAINT booking_policies_version_check CHECK (version > 0)
);

GRANT SELECT, INSERT, UPDATE ON booking_policies TO melissa_runtime;

ALTER TABLE booking_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY booking_policies_tenant_scope ON booking_policies TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

INSERT INTO booking_policies (tenant_id)
SELECT id FROM tenants
ON CONFLICT DO NOTHING;

UPDATE infrastructure_metadata SET value='34' WHERE key='schema_version';
COMMIT;
