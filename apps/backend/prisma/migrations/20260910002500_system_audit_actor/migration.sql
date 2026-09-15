BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE audit_events DROP CONSTRAINT audit_actor_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_actor_check CHECK (
  (actor_type='user' AND actor_id IS NOT NULL) OR
  (actor_type IN ('whatsapp','system') AND actor_id IS NULL)
);

UPDATE infrastructure_metadata SET value='25' WHERE key='schema_version';
COMMIT;
