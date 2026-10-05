BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION discover_calendar_credentials_for_reencryption(
  p_current_key_id varchar,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (tenant_id uuid, connection_id uuid, key_id varchar)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.tenant_id, c.connection_id, c.key_id
  FROM calendar_credentials c
  WHERE c.key_id <> p_current_key_id
  ORDER BY c.updated_at, c.tenant_id, c.connection_id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

REVOKE ALL ON FUNCTION discover_calendar_credentials_for_reencryption(varchar, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_calendar_credentials_for_reencryption(varchar, integer)
  TO melissa_runtime;

UPDATE infrastructure_metadata SET value='53' WHERE key='schema_version';
COMMIT;
