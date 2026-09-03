ALTER TABLE inbound_outbox ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE inbound_outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'mock';
ALTER TABLE inbound_outbox ADD COLUMN integration_key VARCHAR(128);
ALTER TABLE inbound_outbox ADD CONSTRAINT inbound_origin_check CHECK (
  (origin='mock' AND actor_id IS NOT NULL AND integration_key IS NULL) OR
  (origin='whatsapp' AND actor_id IS NULL AND integration_key IS NOT NULL)
);
ALTER TABLE audit_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE audit_events ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE audit_events ADD CONSTRAINT audit_actor_check CHECK (
  (actor_type='user' AND actor_id IS NOT NULL) OR
  (actor_type='whatsapp' AND actor_id IS NULL)
);
UPDATE infrastructure_metadata SET value='10' WHERE key='schema_version';
