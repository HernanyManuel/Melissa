import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

export async function testQuarantineOperations(
  tenantId: string,
  otherTenant: string,
  ownerToken: string,
  otherToken: string,
  get: (path: string, token?: string) => Promise<Response>,
) {
  const url = process.env.MIGRATION_DATABASE_URL;
  assert(url);
  const admin = new PrismaClient({ datasources: { db: { url } } });
  const path = `/tenants/${tenantId}/quarantine`;
  const owner = await admin.membership.findFirstOrThrow({ where: { tenantId, role: 'owner' } });
  try {
    assert.equal((await get(path)).status, 401);
    assert.equal((await get(path, otherToken)).status, 404);
    assert.equal((await get(path + '?after=invalid', ownerToken)).status, 400);
    const channel = await admin.channelConnection.findFirstOrThrow({ where: { tenantId } });
    const ids = Array.from({ length: 51 }, () => randomUUID());
    const expiresAt = new Date(Date.now() + 12 * 3600000);
    await admin.$transaction(async (tx) => {
      await tx.externalEvent.createMany({
        data: ids.map((id) => ({
          id,
          tenantId,
          provider: 'test-quarantine-metadata',
          externalEventId: id,
          eventType: 'test',
          payloadHash: '0'.repeat(64),
        })),
      });
      await tx.whatsAppQuarantine.createMany({
        data: ids.map((id) => ({
          id,
          tenantId,
          channelId: channel.id,
          expiresAt,
          keyId: 'never-return-this-key-id',
          nonce: Buffer.alloc(12),
          tag: Buffer.alloc(16),
          ciphertext: Buffer.from('never-return-this-payload'),
        })),
      });
      await tx.quarantineExpiry.createMany({
        data: ids.map((id) => ({ id, tenantId, expiresAt })),
      });
    });
    const first = await get(path, ownerToken);
    assert.equal(first.status, 200);
    const body = await first.text();
    for (const secret of ['ciphertext', 'nonce', 'tag', 'keyId', 'never-return'])
      assert(!body.includes(secret));
    const page = JSON.parse(body) as {
      items: Array<Record<string, unknown>>;
      next: string;
      total: number;
      expiringSoon: number;
      notices: string[];
    };
    assert.equal(page.items.length, 50);
    assert(page.total >= 51);
    assert(page.expiringSoon >= 51);
    assert(page.notices.includes('expiring_soon'));
    assert(!page.notices.includes('capacity_full'));
    assert(page.next);
    assert.deepEqual(
      Object.keys(page.items[0]!).sort(),
      ['id', 'channelId', 'channelName', 'createdAt', 'expiresAt', 'expired'].sort(),
    );
    const second = (await (await get(path + '?after=' + page.next, ownerToken)).json()) as {
      items: Array<{ id: string }>;
    };
    assert(second.items.length > 0);
    assert(second.items.every((item) => !page.items.some((previous) => previous.id === item.id)));
    const other = (await (await get(`/tenants/${otherTenant}/quarantine`, otherToken)).json()) as {
      total: number;
      notices: string[];
    };
    assert.equal(other.total, 0);
    assert.deepEqual(other.notices, []);
    for (const role of ['admin', 'manager', 'staff', 'viewer'] as const) {
      await admin.membership.update({ where: { id: owner.id }, data: { role } });
      assert.equal((await get(path, ownerToken)).status, role === 'admin' ? 200 : 403);
    }
  } finally {
    await admin.membership.update({ where: { id: owner.id }, data: { role: 'owner' } });
    await admin.$disconnect();
  }
}
