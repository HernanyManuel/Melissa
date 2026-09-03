import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

export async function testProcessing(
  tenantId: string,
  otherTenant: string,
  ownerToken: string,
  otherToken: string,
  get: (path: string, token?: string) => Promise<Response>,
) {
  assert(process.env.MIGRATION_DATABASE_URL);
  const db = new PrismaClient({ datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } } });
  const path = `/tenants/${tenantId}/message-processing`;
  const owner = await db.membership.findFirstOrThrow({ where: { tenantId, role: 'owner' } });
  try {
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, otherToken)).status, 404);
    for (const query of ['state=processed', 'state=invalid', 'after=invalid', 'limit=500'])
      assert.equal((await get(`${path}?${query}`, ownerToken)).status, 400);
    const source = await db.inboundOutbox.findFirstOrThrow({ where: { tenantId } });
    const ids: string[] = Array.from({ length: 51 }, () => randomUUID());
    await db.$transaction(async (tx) => {
      await tx.externalEvent.createMany({
        data: ids.map((id) => ({
          id,
          tenantId,
          provider: 'mock',
          externalEventId: id,
          eventType: 'message.received',
          payloadHash: '0'.repeat(64),
        })),
      });
      await tx.inboundOutbox.createMany({
        data: ids.map((id) => ({
          id,
          tenantId,
          channelId: source.channelId,
          customerId: source.customerId,
          actorId: owner.userId,
          origin: 'mock',
          contentText: null,
        })),
      });
      await tx.inboundDispatch.createMany({
        data: ids.map((id) => ({ id, tenantId, state: 'failed', attempts: 5 })),
      });
    });
    const response = await get(`${path}?state=failed`, ownerToken);
    assert.equal(response.status, 200);
    const first = (await response.json()) as {
      items: Array<{ id: string; state: string; attempts: number; nextAttemptAt: null }>;
      next: string;
    };
    assert.equal(first.items.length, 50);
    assert(first.next);
    for (const row of first.items) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ['id', 'state', 'attempts', 'nextAttemptAt'].sort(),
      );
      assert.equal(row.state, 'failed');
      assert.equal(row.nextAttemptAt, null);
    }
    const second = (await (
      await get(`${path}?state=failed&after=${first.next}`, ownerToken)
    ).json()) as { items: Array<{ id: string }> };
    assert(second.items.length > 0);
    assert(second.items.every((row) => !first.items.some((previous) => previous.id === row.id)));
    const other = (await (
      await get(`/tenants/${otherTenant}/message-processing?state=failed`, otherToken)
    ).json()) as { items: Array<{ id: string }> };
    assert(other.items.every((row) => !ids.includes(row.id)));
    // All listed rows must belong to the authorized tenant.
    const ownIds = new Set(
      (
        await db.inboundDispatch.findMany({
          where: { tenantId, state: 'failed' },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    assert([...first.items, ...second.items].every((row) => ownIds.has(row.id)));
    for (const role of ['admin', 'manager', 'staff', 'viewer'] as const) {
      await db.membership.update({ where: { id: owner.id }, data: { role } });
      assert.equal((await get(path, ownerToken)).status, role === 'admin' ? 200 : 403);
    }
  } finally {
    await db.membership.update({ where: { id: owner.id }, data: { role: 'owner' } });
    await db.$disconnect();
  }
}
