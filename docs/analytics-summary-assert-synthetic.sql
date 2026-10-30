-- Validate medium/large synthetic fixtures under the restricted runtime role.
-- Required psql variables: tenant_id, expected_conversations, expected_turns,
-- expected_audits. Use only against a disposable synthetic PostgreSQL database.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $runtime_guard$
BEGIN
  IF current_user <> 'melissa_runtime' THEN
    RAISE EXCEPTION 'expected melissa_runtime, got %', current_user;
  END IF;
END
$runtime_guard$;
SELECT set_config('app.tenant_id', :'tenant_id', true);
-- Division by zero deliberately fails the script for unexpected counts.
-- Each query is scoped to the requested tenant and RLS remains enforced.
SELECT 1 / CASE WHEN COUNT(*) = :expected_conversations::bigint THEN 1 ELSE 0 END
  AS conversations_match
FROM conversations WHERE tenant_id = :'tenant_id'::uuid;
SELECT 1 / CASE WHEN COUNT(*) = :expected_turns::bigint THEN 1 ELSE 0 END
  AS ai_turns_match
FROM ai_turns WHERE tenant_id = :'tenant_id'::uuid;
SELECT 1 / CASE WHEN COUNT(*) = :expected_audits::bigint THEN 1 ELSE 0 END
  AS audit_events_match
FROM audit_events WHERE tenant_id = :'tenant_id'::uuid;
ROLLBACK;
