-- P10 read-only query-plan baseline for a NON-PRODUCTION PostgreSQL dataset.
-- Run with psql -X -v ON_ERROR_STOP=1 -v tenant_id=<TEST_TENANT_UUID>
-- authenticated as melissa_runtime (NOT an owner/superuser/BYPASSRLS role).
-- Database must already have schema 79 and representative synthetic rows.
-- EXPLAIN ANALYZE executes SELECT statements and may incur measurable load.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
-- Fail closed: a privileged login may bypass FORCE RLS and invalidate this baseline.
DO $benchmark_guard$
BEGIN
  IF current_user <> 'melissa_runtime' THEN
    RAISE EXCEPTION 'benchmark requires melissa_runtime, got %', current_user;
  END IF;
END
$benchmark_guard$;
SELECT set_config('app.tenant_id', :'tenant_id', true);
SELECT current_user AS execution_role,
       current_setting('app.tenant_id', true) AS scoped_tenant;
-- Annotate the plan with PostgreSQL table estimates (not measured row counts).
-- Small/empty CI datasets must never be mistaken for representative load.
SELECT current_setting('server_version') AS postgres_version;
SELECT relname AS table_name, n_live_tup AS estimated_live_rows,
       last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname IN ('conversations','ai_turns','audit_events')
ORDER BY relname;
-- Every query uses the same [from,to) window; psql reuses it in one transaction.
SELECT now() AS window_to, now()-interval '30 days' AS window_from \gset
-- Exact tenant-visible totals are diagnostic sample sizes, not performance claims.
-- Label missing synthetic load explicitly rather than comparing empty-table timings.
SELECT 'conversations' AS source, COUNT(*)::bigint AS tenant_rows,
       COUNT(*) FILTER (WHERE opened_at >= :'window_from'::timestamptz
                         AND opened_at < :'window_to'::timestamptz)::bigint AS window_rows
FROM conversations WHERE tenant_id=:'tenant_id'::uuid
UNION ALL
SELECT 'ai_turns', COUNT(*)::bigint,
       COUNT(*) FILTER (WHERE started_at >= :'window_from'::timestamptz
                         AND started_at < :'window_to'::timestamptz)::bigint
FROM ai_turns WHERE tenant_id=:'tenant_id'::uuid
UNION ALL
SELECT 'audit_events', COUNT(*)::bigint,
       COUNT(*) FILTER (WHERE created_at >= :'window_from'::timestamptz
                         AND created_at < :'window_to'::timestamptz)::bigint
FROM audit_events WHERE tenant_id=:'tenant_id'::uuid;

-- Fail the CI smoke test if the expected synthetic tenant is empty or skewed.
-- Optional: real/non-small benchmarking omits expect_small and these checks.
\if :{?expect_small}
DO $synthetic_small_guard$
DECLARE
  conversation_total bigint;
  turn_total bigint;
  audit_total bigint;
  conversation_window bigint;
  turn_window bigint;
  audit_window bigint;
  start_bound timestamptz := now() - interval '30 days';
  end_bound timestamptz := now();
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE opened_at >= start_bound AND opened_at < end_bound)
    INTO conversation_total, conversation_window
    FROM conversations WHERE tenant_id = current_setting('app.tenant_id')::uuid;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE started_at >= start_bound AND started_at < end_bound)
    INTO turn_total, turn_window
    FROM ai_turns WHERE tenant_id = current_setting('app.tenant_id')::uuid;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at >= start_bound AND created_at < end_bound)
    INTO audit_total, audit_window
    FROM audit_events WHERE tenant_id = current_setting('app.tenant_id')::uuid;
  IF conversation_total <> 100 OR turn_total <> 300 OR audit_total <> 300 THEN
    RAISE EXCEPTION 'unexpected synthetic totals: conversations %, turns %, audits %',
      conversation_total, turn_total, audit_total;
  END IF;
  IF conversation_window NOT BETWEEN 40 AND 60
     OR turn_window NOT BETWEEN 120 AND 180
     OR audit_window NOT BETWEEN 120 AND 180 THEN
    RAISE EXCEPTION 'unexpected 30-day synthetic window coverage: conversations %, turns %, audits %',
      conversation_window, turn_window, audit_window;
  END IF;
END
$synthetic_small_guard$;
\endif

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
