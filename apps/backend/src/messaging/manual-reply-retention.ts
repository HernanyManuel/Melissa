import { PrismaClient } from '@prisma/client';

/**
 * One bounded, non-sending maintenance batch. Must be run with the migration
 * database role by a controlled operator. The locked parent rows serialize
 * with normal reply confirmation (which also locks its parent intent).
 *
 * No dispatch row may exist: queued, accepted, rejected and failed replies
 * keep their original text for audit and provider reconciliation.
 */
export async function redactExpiredPreparations(db: PrismaClient, limit: number): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid batch limit');
  const changed = await db.$queryRaw<Array<{ id: string }>>`
    WITH candidates AS (
      SELECT i.tenant_id, i.id
      FROM human_outbound_intents i
      WHERE i.redacted_at IS NULL
        AND (i.abandoned_at IS NOT NULL OR i.created_at <= now() - INTERVAL '24 hours')
        AND NOT EXISTS (
          SELECT 1 FROM human_outbound_dispatch d
          WHERE d.tenant_id=i.tenant_id AND d.id=i.id
        )
      ORDER BY i.created_at, i.id
      LIMIT ${limit}
      FOR UPDATE OF i SKIP LOCKED
    )
    UPDATE human_outbound_intents i
    SET content_text='[redacted]', redacted_at=now()
    FROM candidates c
    WHERE i.tenant_id=c.tenant_id AND i.id=c.id
      AND i.redacted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM human_outbound_dispatch d
        WHERE d.tenant_id=i.tenant_id AND d.id=i.id
      )
    RETURNING i.id::text AS id
  `;
  return changed.length;
}

export async function pendingRedactionCount(db: PrismaClient): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM human_outbound_intents i
    WHERE i.redacted_at IS NULL
      AND (i.abandoned_at IS NOT NULL OR i.created_at <= now() - INTERVAL '24 hours')
      AND NOT EXISTS (
        SELECT 1 FROM human_outbound_dispatch d
        WHERE d.tenant_id=i.tenant_id AND d.id=i.id
      )
  `;
  return Number(row?.count ?? 0n);
}
