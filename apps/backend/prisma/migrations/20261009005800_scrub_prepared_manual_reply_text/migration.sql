BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Keep request_id / actor / conversation / epoch as a non-sendable tombstone,
-- but no longer retain the original message text once its draft is discarded.
ALTER TABLE human_outbound_intents
  ADD COLUMN redacted_at TIMESTAMPTZ(6);

-- Scrub abandoned and already-expired NON-DISPATCHED preparations at rollout.
-- Dispatch content stays untouched: workers and receipts still need that text.
UPDATE human_outbound_intents AS i
SET content_text='[redacted]', redacted_at=CURRENT_TIMESTAMP
WHERE redacted_at IS NULL
  AND (abandoned_at IS NOT NULL OR created_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours')
  AND NOT EXISTS (
    SELECT 1 FROM human_outbound_dispatch AS d
    WHERE d.tenant_id=i.tenant_id AND d.id=i.id
  );

ALTER TABLE human_outbound_intents
  ADD CONSTRAINT human_outbound_intents_redaction_check CHECK (
    redacted_at IS NULL OR content_text='[redacted]'
  );

-- Guard against privileged runtime mistakes, stale client retries and
-- attempts to redact already-dispatched messages. The parent intent row is
-- locked FOR UPDATE by callers before confirming or redacting.
CREATE FUNCTION enforce_human_intent_redaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.abandoned_at IS NOT NULL AND NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at THEN
    RAISE EXCEPTION 'manual reply abandonment cannot be reversed';
  END IF;
  IF NEW.content_text IS DISTINCT FROM OLD.content_text
     OR NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    IF OLD.redacted_at IS NOT NULL
       OR NEW.content_text <> '[redacted]'
       OR NEW.redacted_at IS NULL
       OR (NEW.abandoned_at IS NULL
           AND OLD.created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours')
       OR EXISTS (
         SELECT 1 FROM human_outbound_dispatch d
         WHERE d.tenant_id=OLD.tenant_id AND d.id=OLD.id
       ) THEN
      RAISE EXCEPTION 'manual reply cannot be redacted';
    END IF;
  END IF;
  IF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at
     AND NEW.abandoned_at IS NOT NULL AND NEW.redacted_at IS NULL THEN
    RAISE EXCEPTION 'manual reply abandonment requires text redaction';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER human_outbound_intents_redaction_guard
BEFORE UPDATE ON human_outbound_intents
FOR EACH ROW EXECUTE FUNCTION enforce_human_intent_redaction();

GRANT UPDATE (content_text, redacted_at) ON human_outbound_intents TO melissa_runtime;

UPDATE infrastructure_metadata SET value='58' WHERE key='schema_version';
COMMIT;
