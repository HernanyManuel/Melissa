BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE inbox_events (
  tenant_id UUID NOT NULL,
  sequence BIGINT NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID,
  actor_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inbox_events_pkey PRIMARY KEY (tenant_id, sequence),
  CONSTRAINT inbox_events_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT inbox_events_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbox_events_sequence_positive CHECK (sequence > 0),
  CONSTRAINT inbox_events_type_check CHECK (
    event_type IN (
      'message.received',
      'conversation.handoff_requested',
      'conversation.takeover',
      'conversation.ai_reactivated',
      'conversation.closed'
    )
  )
);

CREATE INDEX inbox_events_conversation_idx
  ON inbox_events(tenant_id, conversation_id, sequence);

CREATE FUNCTION assign_inbox_event_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM tenants WHERE id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inbox event tenant does not exist';
  END IF;

  SELECT COALESCE(MAX(sequence), 0) + 1
  INTO NEW.sequence
  FROM inbox_events
  WHERE tenant_id=NEW.tenant_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inbox_events_sequence
BEFORE INSERT ON inbox_events
FOR EACH ROW EXECUTE FUNCTION assign_inbox_event_sequence();

ALTER TABLE inbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_events_tenant_scope ON inbox_events TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON inbox_events TO melissa_runtime;
GRANT INSERT (tenant_id, event_type, conversation_id, message_id, actor_id)
  ON inbox_events TO melissa_runtime;

UPDATE infrastructure_metadata SET value='55' WHERE key='schema_version';
COMMIT;
