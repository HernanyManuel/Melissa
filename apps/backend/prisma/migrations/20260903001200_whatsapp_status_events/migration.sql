CREATE TABLE whatsapp_status_events (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  channel_id UUID NOT NULL,
  external_message_id VARCHAR(512) NOT NULL,
  recipient_id VARCHAR(32) NOT NULL CHECK(recipient_id ~ '^[0-9]{1,32}$'),
  status TEXT NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,id) REFERENCES external_events(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,channel_id) REFERENCES channel_connections(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX whatsapp_status_message_idx ON whatsapp_status_events(tenant_id,channel_id,external_message_id,occurred_at);
ALTER TABLE whatsapp_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON whatsapp_status_events TO melissa_runtime
  USING(tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT ON whatsapp_status_events TO melissa_runtime;
UPDATE infrastructure_metadata SET value='12' WHERE key='schema_version';
