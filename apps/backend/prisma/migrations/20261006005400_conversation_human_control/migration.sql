BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE conversations
  ADD COLUMN assigned_staff_id UUID,
  ADD COLUMN closed_at TIMESTAMPTZ(6),
  ADD CONSTRAINT conversations_assigned_staff_fkey
    FOREIGN KEY (tenant_id, assigned_staff_id)
    REFERENCES staff(tenant_id, id)
    ON DELETE RESTRICT;

CREATE INDEX conversations_assigned_staff_idx
  ON conversations(tenant_id, assigned_staff_id, last_message_at, id)
  WHERE assigned_staff_id IS NOT NULL;

UPDATE infrastructure_metadata SET value='54' WHERE key='schema_version';
COMMIT;
