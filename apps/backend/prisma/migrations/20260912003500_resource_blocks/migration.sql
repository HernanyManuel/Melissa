BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE resource_blocks (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  resource_id UUID NOT NULL,
  starts_at TIMESTAMPTZ(6) NOT NULL,
  ends_at TIMESTAMPTZ(6) NOT NULL,
  reason VARCHAR(500),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT resource_blocks_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT resource_blocks_id_key UNIQUE (id),
  CONSTRAINT resource_blocks_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT resource_blocks_resource_fkey FOREIGN KEY (tenant_id, resource_id)
    REFERENCES booking_resources(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT resource_blocks_interval_check CHECK (ends_at > starts_at)
);

CREATE INDEX resource_blocks_overlap_idx
  ON resource_blocks USING gist (
    tenant_id,
    resource_id,
    tstzrange(starts_at, ends_at, '[)')
  );

CREATE FUNCTION lock_booking_resource_for_block() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    (OLD.tenant_id, OLD.resource_id) IS DISTINCT FROM (NEW.tenant_id, NEW.resource_id) THEN
    PERFORM 1
    FROM booking_resources
    WHERE (tenant_id, id) IN (
      (OLD.tenant_id, OLD.resource_id),
      (NEW.tenant_id, NEW.resource_id)
    )
    ORDER BY tenant_id, id
    FOR UPDATE;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM 1
    FROM booking_resources
    WHERE tenant_id=OLD.tenant_id AND id=OLD.resource_id
    FOR UPDATE;
  ELSE
    PERFORM 1
    FROM booking_resources
    WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id
    FOR UPDATE;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER resource_blocks_lock_resource
BEFORE INSERT OR UPDATE OR DELETE ON resource_blocks
FOR EACH ROW EXECUTE FUNCTION lock_booking_resource_for_block();

GRANT SELECT, INSERT, UPDATE, DELETE ON resource_blocks TO melissa_runtime;

ALTER TABLE resource_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_blocks FORCE ROW LEVEL SECURITY;

CREATE POLICY resource_blocks_tenant_scope ON resource_blocks TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

UPDATE infrastructure_metadata SET value='35' WHERE key='schema_version';
COMMIT;
