BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE inbox_events
  DROP CONSTRAINT inbox_events_type_check,
  ADD CONSTRAINT inbox_events_type_check CHECK (
    event_type IN (
      'message.received',
      'message.sent',
      'conversation.handoff_requested',
      'conversation.takeover',
      'conversation.ai_reactivated',
      'conversation.closed'
    )
  );

CREATE TABLE human_outbound_intents (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  actor_id UUID NOT NULL,
  request_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  mode_epoch BIGINT NOT NULL,
  content_text VARCHAR(4096) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT human_outbound_intents_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT human_outbound_intents_id_key UNIQUE (id),
  CONSTRAINT human_outbound_intents_request_key UNIQUE (tenant_id, actor_id, request_id),
  CONSTRAINT human_outbound_intents_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT human_outbound_intents_actor_fkey FOREIGN KEY (tenant_id, actor_id)
    REFERENCES memberships(tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT human_outbound_intents_conversation_fkey FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT human_outbound_intents_epoch_check CHECK (mode_epoch >= 0),
  CONSTRAINT human_outbound_intents_content_check CHECK (
    length(btrim(content_text)) BETWEEN 1 AND 4096
  )
);

CREATE INDEX human_outbound_intents_conversation_idx
  ON human_outbound_intents(tenant_id, conversation_id, created_at, id);

CREATE TABLE human_outbound_dispatch (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provider_message_id VARCHAR(512),
  accepted_at TIMESTAMPTZ(6),
  CONSTRAINT human_outbound_dispatch_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT human_outbound_dispatch_intent_fkey FOREIGN KEY (tenant_id, id)
    REFERENCES human_outbound_intents(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT human_outbound_dispatch_state_check CHECK (
    state IN ('pending', 'accepted', 'rejected', 'failed')
  ),
  CONSTRAINT human_outbound_dispatch_attempts_check CHECK (attempts BETWEEN 0 AND 5)
);

CREATE INDEX human_outbound_dispatch_due_idx
  ON human_outbound_dispatch(state, next_attempt_at, id);

CREATE TABLE human_outbound_dead_letters (
  tenant_id UUID NOT NULL,
  dispatch_id UUID NOT NULL,
  reason VARCHAR(32) NOT NULL,
  attempts INTEGER NOT NULL,
  failed_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT human_outbound_dead_letters_pkey PRIMARY KEY (tenant_id, dispatch_id),
  CONSTRAINT human_outbound_dead_letters_dispatch_fkey FOREIGN KEY (tenant_id, dispatch_id)
    REFERENCES human_outbound_dispatch(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT human_outbound_dead_letters_reason_check CHECK (
    reason IN ('retry_exhausted', 'delivery_unknown')
  ),
  CONSTRAINT human_outbound_dead_letters_attempts_check CHECK (attempts BETWEEN 1 AND 5)
);

CREATE INDEX human_outbound_dead_letters_failed_idx
  ON human_outbound_dead_letters(failed_at, tenant_id, dispatch_id);

ALTER TABLE human_outbound_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_outbound_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY human_outbound_intents_tenant_scope ON human_outbound_intents TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

ALTER TABLE human_outbound_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_outbound_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY human_outbound_dispatch_discovery ON human_outbound_dispatch FOR SELECT TO melissa_runtime
  USING (true);
CREATE POLICY human_outbound_dispatch_insert ON human_outbound_dispatch FOR INSERT TO melissa_runtime
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));
CREATE POLICY human_outbound_dispatch_update ON human_outbound_dispatch FOR UPDATE TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

ALTER TABLE human_outbound_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_outbound_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY human_outbound_dead_letters_tenant_scope ON human_outbound_dead_letters TO melissa_runtime
  USING (tenant_id::text=current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text=current_setting('app.tenant_id', true));

GRANT SELECT ON human_outbound_intents TO melissa_runtime;
GRANT INSERT
  (tenant_id, id, actor_id, request_id, conversation_id, mode_epoch, content_text, created_at)
  ON human_outbound_intents TO melissa_runtime;

GRANT SELECT ON human_outbound_dispatch TO melissa_runtime;
GRANT INSERT (tenant_id, id, state, attempts, next_attempt_at)
  ON human_outbound_dispatch TO melissa_runtime;
GRANT UPDATE
  (state, attempts, next_attempt_at, provider_message_id, accepted_at)
  ON human_outbound_dispatch TO melissa_runtime;

GRANT SELECT ON human_outbound_dead_letters TO melissa_runtime;
GRANT INSERT (tenant_id, dispatch_id, reason, attempts)
  ON human_outbound_dead_letters TO melissa_runtime;

UPDATE infrastructure_metadata SET value='56' WHERE key='schema_version';
COMMIT;
