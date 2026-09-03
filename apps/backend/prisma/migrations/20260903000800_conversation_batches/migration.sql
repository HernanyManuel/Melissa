CREATE TABLE inbound_batches (
  tenant_id UUID NOT NULL, id UUID NOT NULL,
  channel_id UUID NOT NULL, customer_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), due_at TIMESTAMPTZ NOT NULL, sealed_at TIMESTAMPTZ,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,channel_id) REFERENCES channel_connections(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT,
  CHECK(due_at >= created_at AND due_at <= created_at + interval '5 seconds')
);
CREATE INDEX inbound_batches_scope_due_idx ON inbound_batches(tenant_id,channel_id,customer_id,due_at);
ALTER TABLE inbound_batches ENABLE ROW LEVEL SECURITY; ALTER TABLE inbound_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inbound_batches TO melissa_runtime USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON inbound_batches TO melissa_runtime;
GRANT UPDATE(due_at,sealed_at) ON inbound_batches TO melissa_runtime;
ALTER TABLE inbound_outbox ADD COLUMN batch_id UUID;
ALTER TABLE inbound_outbox ADD FOREIGN KEY(tenant_id,batch_id) REFERENCES inbound_batches(tenant_id,id) ON DELETE RESTRICT;
CREATE INDEX inbound_outbox_tenant_batch_idx ON inbound_outbox(tenant_id,batch_id);
ALTER TABLE messages ADD COLUMN batch_id UUID;
ALTER TABLE messages ADD FOREIGN KEY(tenant_id,batch_id) REFERENCES inbound_batches(tenant_id,id) ON DELETE RESTRICT;
UPDATE infrastructure_metadata SET value='8' WHERE key='schema_version';
