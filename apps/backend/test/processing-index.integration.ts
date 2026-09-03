import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

// Inspect the migrated catalog without planner overrides or synthetic timings.
export async function assertProcessingIndex(db: PrismaClient) {
  const rows = await db.$queryRaw<
    Array<{
      valid: boolean;
      ready: boolean;
      method: string;
      columns: string[];
      predicate: string | null;
    }>
  >`
    SELECT i.indisvalid AS valid, i.indisready AS ready, am.amname AS method,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
        ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_am am ON am.oid=idx.relam
    WHERE i.indrelid='public.inbound_dispatch'::regclass
      AND idx.relname='inbound_dispatch_tenant_state_id_idx'`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.valid, true);
  assert.equal(rows[0]!.ready, true);
  assert.equal(rows[0]!.method, 'btree');
  assert.deepEqual(rows[0]!.columns, ['tenant_id', 'state', 'id']);
  assert.equal(rows[0]!.predicate, null);
  const existing = await db.$queryRaw<Array<{ valid: boolean }>>`
    SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid='public.inbound_dispatch'::regclass AND c.relname='inbound_dispatch_due_idx'`;
  assert.equal(existing.length, 1);
  assert.equal(existing[0]!.valid, true, 'Global worker dispatch index must remain available');
}
