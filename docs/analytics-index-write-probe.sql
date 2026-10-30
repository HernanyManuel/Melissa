-- P10 disposable benchmark only: write amplification proxy, NOT production throughput.
-- Must run as migration owner against local disposable database, never runtime/production.
\set ON_ERROR_STOP on
SELECT current_database() = 'melissa_test' AS disposable_database \gset
\if :disposable_database
\else
  \echo 'Refusing write benchmark outside melissa_test'
  \quit 1
\endif
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT TEXT)
UPDATE conversations SET opened_at = opened_at + interval '1 microsecond'
WHERE ctid IN (SELECT ctid FROM conversations ORDER BY ctid LIMIT 500);
ROLLBACK;
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT TEXT)
UPDATE ai_turns SET started_at = started_at + interval '1 microsecond'
WHERE ctid IN (SELECT ctid FROM ai_turns ORDER BY ctid LIMIT 500);
ROLLBACK;
-- Rollback prevents logical changes, but may still leave dead tuples/WAL;
-- use only as a coarse repeated-measurement proxy, not an insert-cost SLA.
