-- P10 read-only query-plan baseline for a NON-PRODUCTION PostgreSQL dataset.
-- Run with psql -X -v ON_ERROR_STOP=1 -v tenant_id=<TEST_TENANT_UUID>
-- authenticated as melissa_runtime (NOT an owner/superuser/BYPASSRLS role).
-- Database must already have schema 79 and representative synthetic rows.
-- EXPLAIN ANALYZE executes SELECT statements and may incur measurable load.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
-- Fail closed: a privileged login may bypass FORCE RLS and invalidate this baseline.
DO $
BEGIN
  IF current_user <> 'melissa_runtime' THEN
    RAISE EXCEPTION 'benchmark requires melissa_runtime, got %', current_user;
  END IF;
END
$;
SELECT set_config('app.tenant_id', :'tenant_id', true);
SELECT current_user AS execution_role,
       current_setting('app.tenant_id', true) AS scoped_tenant;
-- Every query uses the same [from,to) window; psql reuses it in one transaction.
SELECT now() AS window_to, now()-interval '30 days' AS window_from \gset
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*)::text AS count FROM conversations
WHERE tenant_id=:'tenant_id'::uuid
  AND opened_at >= :'window_from'::timestamptz
  AND opened_at < :'window_to'::timestamptz;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*)::text AS started,
       COUNT(*) FILTER (WHERE status='completed')::text AS completed,
       COUNT(*) FILTER (WHERE status='failed')::text AS failed,
       COUNT(*) FILTER (WHERE status='running')::text AS running
FROM ai_turns
WHERE tenant_id=:'tenant_id'::uuid
  AND started_at >= :'window_from'::timestamptz
  AND started_at < :'window_to'::timestamptz;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT COUNT(*)::text AS count FROM audit_events
WHERE tenant_id=:'tenant_id'::uuid
  AND created_at >= :'window_from'::timestamptz
  AND created_at < :'window_to'::timestamptz;
ROLLBACK;
