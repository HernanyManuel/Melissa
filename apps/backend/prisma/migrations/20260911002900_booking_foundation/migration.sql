BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE booking_resources (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  kind VARCHAR(16) NOT NULL,
  staff_id UUID,
  name VARCHAR(160) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_resources_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT booking_resources_id_key UNIQUE (id),
  CONSTRAINT booking_resources_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT booking_resources_staff_fkey FOREIGN KEY (tenant_id, staff_id)
    REFERENCES staff(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT booking_resources_kind_check CHECK (kind IN ('default', 'staff')),
  CONSTRAINT booking_resources_staff_check CHECK (
    (kind='default' AND staff_id IS NULL) OR (kind='staff' AND staff_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX booking_resources_default_key
  ON booking_resources(tenant_id) WHERE kind='default';
CREATE UNIQUE INDEX booking_resources_staff_key
  ON booking_resources(tenant_id, staff_id) WHERE kind='staff';
CREATE INDEX booking_resources_active_idx
  ON booking_resources(tenant_id, active, kind, id);

CREATE TABLE bookings (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  service_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  conversation_id UUID,
  source VARCHAR(24) NOT NULL DEFAULT 'manual',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  starts_at TIMESTAMPTZ(6) NOT NULL,
  ends_at TIMESTAMPTZ(6) NOT NULL,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  occupied_start_at TIMESTAMPTZ(6) GENERATED ALWAYS AS
    (starts_at - make_interval(mins => buffer_before_minutes)) STORED,
  occupied_end_at TIMESTAMPTZ(6) GENERATED ALWAYS AS
    (ends_at + make_interval(mins => buffer_after_minutes)) STORED,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bookings_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT bookings_id_key UNIQUE (id),
  CONSTRAINT bookings_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT bookings_customer_fkey FOREIGN KEY (tenant_id, customer_id)
    REFERENCES customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_service_fkey FOREIGN KEY (tenant_id, service_id)
    REFERENCES services(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_resource_fkey FOREIGN KEY (tenant_id, resource_id)
    REFERENCES booking_resources(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bookings_source_check CHECK (source IN ('manual', 'ai', 'google')),
  CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  CONSTRAINT bookings_interval_check CHECK (ends_at > starts_at),
  CONSTRAINT bookings_buffer_before_check CHECK (buffer_before_minutes BETWEEN 0 AND 1440),
  CONSTRAINT bookings_buffer_after_check CHECK (buffer_after_minutes BETWEEN 0 AND 1440),
  CONSTRAINT bookings_version_check CHECK (version > 0)
);

ALTER TABLE bookings ADD CONSTRAINT bookings_no_resource_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));

CREATE INDEX bookings_customer_idx
  ON bookings(tenant_id, customer_id, starts_at, id);
CREATE INDEX bookings_resource_idx
  ON bookings(tenant_id, resource_id, starts_at, id);
CREATE INDEX bookings_status_idx
  ON bookings(tenant_id, status, starts_at, id);

GRANT SELECT, INSERT, UPDATE ON booking_resources, bookings TO melissa_runtime;

ALTER TABLE booking_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;

CREATE POLICY booking_resources_tenant_scope ON booking_resources TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));
CREATE POLICY bookings_tenant_scope ON bookings TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

INSERT INTO booking_resources (tenant_id, kind, name)
SELECT id, 'default', 'Default resource' FROM tenants
ON CONFLICT DO NOTHING;

UPDATE infrastructure_metadata SET value='29' WHERE key='schema_version';
COMMIT;
