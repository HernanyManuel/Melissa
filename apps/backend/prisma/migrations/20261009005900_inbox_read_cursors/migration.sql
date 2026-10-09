BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE inbox_read_cursors (
  tenant_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  last_read_sequence BIGINT NOT NULL,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inbox_read_cursors_pkey PRIMARY KEY (tenant_id, actor_id, conversation_id),
  CONSTRAINT inbox_read_cursors_membership_fkey FOREIGN KEY (tenant_id, actor_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT inbox_read_cursors_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbox_read_cursors_sequence_check CHECK (last_read_sequence > 0)
);

ALTER TABLE inbox_read_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_read_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_read_cursors_actor_scope ON inbox_read_cursors TO melissa_runtime
  USING (
    tenant_id::text=current_setting('app.tenant_id', true)
    AND actor_id::text=current_setting('app.actor_id', true)
  )
  WITH CHECK (
    tenant_id::text=current_setting('app.tenant_id', true)
    AND actor_id::text=current_setting('app.actor_id', true)
  );

GRANT SELECT ON inbox_read_cursors TO melissa_runtime;
GRANT INSERT (tenant_id, actor_id, conversation_id, last_read_sequence)
  ON inbox_read_cursors TO melissa_runtime;
GRANT UPDATE (last_read_sequence, updated_at) ON inbox_read_cursors TO melissa_runtime;

ALTER TABLE inbox_events
  DROP CONSTRAINT inbox_events_type_check,
  ADD CONSTRAINT inbox_events_type_check CHECK (
    event_type IN (
      'message.received',
      'message.sent',
      'conversation.handoff_requested',
      'conversation.takeover',
      'conversation.ai_reactivated',
      'conversation.closed',
      'conversation.read'
    )
  );

UPDATE infrastructure_metadata SET value='59' WHERE key='schema_version';
COMMIT;
