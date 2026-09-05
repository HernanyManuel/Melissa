ALTER TABLE external_events ALTER COLUMN processed_at DROP NOT NULL;
GRANT UPDATE(processed_at) ON external_events TO melissa_runtime;
CREATE TABLE inbound_outbox (
  tenant_id UUID NOT NULL, id UUID NOT NULL,
  channel_id UUID NOT NULL, customer_id UUID NOT NULL, actor_id UUID NOT NULL REFERENCES users(id),
  content_text VARCHAR(4096), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,id) REFERENCES external_events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,channel_id) REFERENCES channel_connections(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE inbound_outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE inbound_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inbound_outbox TO melissa_runtime USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON inbound_outbox TO melissa_runtime;
GRANT UPDATE(content_text) ON inbound_outbox TO melissa_runtime;
CREATE TABLE inbound_dispatch (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','rejected','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,id) REFERENCES inbound_outbox(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX inbound_dispatch_due_idx ON inbound_dispatch(state,next_attempt_at,id);
-- The dispatcher reads a minimal global envelope. All payload access remains tenant-scoped.
ALTER TABLE inbound_dispatch ENABLE ROW LEVEL SECURITY; ALTER TABLE inbound_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY routing_read ON inbound_dispatch FOR SELECT TO melissa_runtime USING(true);
CREATE POLICY routing_insert ON inbound_dispatch FOR INSERT TO melissa_runtime WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY routing_update ON inbound_dispatch FOR UPDATE TO melissa_runtime USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON inbound_dispatch TO melissa_runtime;
GRANT UPDATE(state,attempts,next_attempt_at) ON inbound_dispatch TO melissa_runtime;
UPDATE infrastructure_metadata SET value='7' WHERE key='schema_version';
