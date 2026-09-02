CREATE TABLE conversations (
  tenant_id UUID NOT NULL REFERENCES tenants(id), id UUID NOT NULL,
  customer_id UUID NOT NULL, channel_connection_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting_customer','waiting_human','closed','archived')),
  mode TEXT NOT NULL DEFAULT 'AI_PAUSED' CHECK(mode IN ('AI_ACTIVE','WAITING_HUMAN','HUMAN_ACTIVE','AI_PAUSED','CLOSED')),
  language TEXT NOT NULL DEFAULT 'pt', last_message_at TIMESTAMPTZ NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), state JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,channel_connection_id,customer_id),
  FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,channel_connection_id) REFERENCES channel_connections(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX conversations_tenant_last_id_idx ON conversations(tenant_id,last_message_at,id);
CREATE TABLE external_events (
  tenant_id UUID NOT NULL REFERENCES tenants(id), id UUID NOT NULL,
  provider TEXT NOT NULL, external_event_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload_hash VARCHAR(64) NOT NULL, processed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), UNIQUE(provider,external_event_id)
);
CREATE TABLE messages (
  tenant_id UUID NOT NULL, id UUID NOT NULL, conversation_id UUID NOT NULL,
  external_event_id UUID NOT NULL UNIQUE,
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound','outbound')),
  sender_type TEXT NOT NULL DEFAULT 'customer' CHECK(sender_type IN ('customer','ai','staff','system')),
  message_type TEXT NOT NULL DEFAULT 'text', content_text VARCHAR(4096) NOT NULL,
  status TEXT NOT NULL DEFAULT 'received', ai_generated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,external_event_id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,external_event_id) REFERENCES external_events(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX messages_tenant_conversation_created_id_idx ON messages(tenant_id,conversation_id,created_at,id);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY; ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY; ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE external_events ENABLE ROW LEVEL SECURITY; ALTER TABLE external_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON conversations TO melissa_runtime USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON messages TO melissa_runtime USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON external_events TO melissa_runtime USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
GRANT SELECT,INSERT,UPDATE ON conversations TO melissa_runtime;
GRANT SELECT,INSERT ON messages,external_events TO melissa_runtime;
UPDATE infrastructure_metadata SET value='6' WHERE key='schema_version';
