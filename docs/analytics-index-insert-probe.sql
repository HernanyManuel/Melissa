-- P10 experimental INSERT probe: disposable melissa_test database only.
-- Execute as migration owner; tenant_id must be a synthetic tenant ID.
\set ON_ERROR_STOP on
SELECT CASE WHEN current_database() = 'melissa_test' THEN 'true' ELSE 'false' END AS disposable \gset
\if :disposable
\else
  \echo 'Refusing INSERT probe outside melissa_test'
  \quit 1
\endif
BEGIN;
-- Each INSERT is rolled back. New customer records avoid the unique
-- (tenant, channel, customer) constraint when adding conversations.
EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT TEXT)
WITH fresh AS MATERIALIZED (
  SELECT gen_random_uuid() AS id, n
  FROM generate_series(1, 200) AS n
), inserted_customers AS (
  INSERT INTO customers (tenant_id, id, display_name, phone_e164, updated_at)
  SELECT :'tenant_id'::uuid, id, 'P10 insert probe', '+351' || (800000000 + n)::text, now()
  FROM fresh
  RETURNING id, tenant_id
)
INSERT INTO conversations
  (tenant_id, id, customer_id, channel_connection_id, last_message_at, opened_at, updated_at)
SELECT c.tenant_id, gen_random_uuid(), c.id, channel.id, now(), now(), now()
FROM inserted_customers c
CROSS JOIN LATERAL (
  SELECT id FROM channel_connections
  WHERE tenant_id = :'tenant_id'::uuid
  ORDER BY id LIMIT 1
) channel;
ROLLBACK;
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT TEXT)
INSERT INTO ai_turns
  (tenant_id, id, conversation_id, customer_id, mode_epoch, state_version, status, rounds, started_at)
SELECT tenant_id, gen_random_uuid(), id, customer_id, 0, 0, 'running', 0, now()
FROM conversations
WHERE tenant_id = :'tenant_id'::uuid
ORDER BY id LIMIT 200;
ROLLBACK;
-- PostgreSQL WAL may still be emitted despite rollback; timings are not
-- production INSERT throughput or clean-state independent samples.
