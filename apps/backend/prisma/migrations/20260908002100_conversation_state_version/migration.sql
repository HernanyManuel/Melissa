BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE conversations
  ADD COLUMN mode_epoch BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN state_version BIGINT NOT NULL DEFAULT 0;

UPDATE conversations SET state = '{"version":1,"intent":null,"stage":"idle","serviceId":null,"date":null,"staffId":null}'::jsonb;

ALTER TABLE conversations
  ALTER COLUMN state SET DEFAULT '{"version":1,"intent":null,"stage":"idle","serviceId":null,"date":null,"staffId":null}'::jsonb,
  ADD CONSTRAINT conversation_state_shape CHECK (
    jsonb_typeof(state) = 'object' AND state->>'version' = '1'
  ),
  ADD CONSTRAINT conversation_mode_epoch_nonnegative CHECK (mode_epoch >= 0),
  ADD CONSTRAINT conversation_state_version_nonnegative CHECK (state_version >= 0);

CREATE FUNCTION enforce_conversation_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    IF NEW.mode_epoch <> OLD.mode_epoch THEN
      RAISE EXCEPTION 'mode_epoch is managed by the database';
    END IF;
    NEW.mode_epoch := OLD.mode_epoch + 1;
  ELSIF NEW.mode_epoch <> OLD.mode_epoch THEN
    RAISE EXCEPTION 'mode_epoch cannot change without mode';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state_version <> OLD.state_version + 1 THEN
      RAISE EXCEPTION 'state change requires the next state_version';
    END IF;
  ELSIF NEW.state_version <> OLD.state_version THEN
    RAISE EXCEPTION 'state_version cannot change without state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_version_guard
BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION enforce_conversation_versions();

UPDATE infrastructure_metadata SET value='21' WHERE key='schema_version';
COMMIT;
