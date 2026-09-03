-- Receiving an inbound message does not establish marketing permission.
ALTER TABLE customers ADD COLUMN marketing_consent_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(marketing_consent_status IN ('unknown','granted','denied'));
ALTER TABLE customers ADD COLUMN whatsapp_opt_in_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(whatsapp_opt_in_status IN ('unknown','granted','denied'));
UPDATE infrastructure_metadata SET value='11' WHERE key='schema_version';
