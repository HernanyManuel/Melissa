BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE staff_hours (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL,
  weekday INTEGER NOT NULL,
  start_time VARCHAR(5) NOT NULL,
  end_time VARCHAR(5) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT staff_hours_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT staff_hours_staff_fkey FOREIGN KEY (tenant_id, staff_id)
    REFERENCES staff(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT staff_hours_weekday_check CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT staff_hours_start_time_check CHECK (start_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT staff_hours_end_time_check CHECK (end_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT staff_hours_interval_check CHECK (start_time::time < end_time::time)
);

CREATE INDEX staff_hours_lookup_idx
  ON staff_hours(tenant_id, staff_id, weekday, enabled, start_time, id);

GRANT SELECT, INSERT, UPDATE, DELETE ON staff_hours TO melissa_runtime;

ALTER TABLE staff_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_hours FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_hours_tenant_scope ON staff_hours TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

UPDATE infrastructure_metadata SET value='33' WHERE key='schema_version';
COMMIT;
