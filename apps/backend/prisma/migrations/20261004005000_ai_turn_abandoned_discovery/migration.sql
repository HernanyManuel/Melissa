BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION discover_abandoned_ai_turns(p_limit integer DEFAULT 100)
RETURNS TABLE (tenant_id uuid, id uuid, dispatch_state varchar)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.tenant_id, t.id, d.state
  FROM ai_turns t
  JOIN ai_turn_dispatch d
    ON d.tenant_id=t.tenant_id AND d.id=t.id
  WHERE t.status='running'
    AND t.execution_lease_id IS NOT NULL
    AND t.execution_lease_expires_at <= CURRENT_TIMESTAMP
    AND (
      (d.state='pending' AND d.attempts < 5)
      OR d.state IN ('processed', 'rejected', 'failed')
    )
  ORDER BY t.execution_lease_expires_at, t.tenant_id, t.id
  LIMIT GREATEST(1, LEAST(p_limit, 500))
$$;

REVOKE ALL ON FUNCTION discover_abandoned_ai_turns(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_abandoned_ai_turns(integer) TO melissa_runtime;

UPDATE infrastructure_metadata SET value='50' WHERE key='schema_version';
COMMIT;
