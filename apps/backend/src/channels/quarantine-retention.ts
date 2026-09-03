import { PrismaClient } from '@prisma/client';
import { log } from '../logging';

// Global discovery exposes only UUIDs/deadline, never encrypted payload or channel identifiers.
export async function purgeExpiredQuarantine(db: PrismaClient): Promise<number> {
  const due = await db.$queryRaw<Array<{ tenant_id: string; id: string }>>`
    SELECT tenant_id,id FROM quarantine_expiry WHERE expires_at < now()
    ORDER BY expires_at,tenant_id,id LIMIT 100`;
  let purged = 0;
  for (const item of due) {
    purged += await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${item.tenant_id},true)`;
      // DB clock and RLS both enforce expiry. Concurrent workers delete at most once.
      const deleted = await tx.$executeRaw`DELETE FROM whatsapp_quarantine
        WHERE tenant_id=${item.tenant_id}::uuid AND id=${item.id}::uuid AND expires_at < now()`;
      if (deleted)
        await tx.auditEvent.create({
          data: {
            tenantId: item.tenant_id,
            actorType: 'whatsapp',
            action: 'message.quarantine_purged',
            targetId: item.id,
          },
        });
      // FK cascade removes the routing envelope; ledger/hash/dedupe receipt are retained.
      return deleted;
    });
  }
  return purged;
}

export function startQuarantineRetention(db: PrismaClient): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      const count = await purgeExpiredQuarantine(db);
      if (count) log.info({ event: 'quarantine_retention_completed', count });
    } catch {
      log.warn({ event: 'quarantine_retention_retry' });
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = tick();
      }, 10000);
  };
  running = tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
