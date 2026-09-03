import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export async function testOutboundIntents(tenantId: string, otherTenantId: string) {
  assert(process.env.MIGRATION_DATABASE_URL);
  assert(process.env.DATABASE_URL);
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
  });
  const runtime = new PrismaClient();
  const fresh = new PrismaClient();
  const scoped = <T>(
    db: PrismaClient,
    tenant: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return fn(tx);
    });
  const sqlError = (code: string) => (error: unknown) =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === code;
  try {
    const conversation = await admin.conversation.findFirstOrThrow({ where: { tenantId } });
    const owner = await admin.membership.findFirstOrThrow({ where: { tenantId, role: 'owner' } });
    const otherOwner = await admin.membership.findFirstOrThrow({
      where: { tenantId: otherTenantId, role: 'owner' },
    });
    const insert = (
      tx: Prisma.TransactionClient,
      requestId = randomUUID(),
      id = randomUUID(),
      text = 'Resposta de teste',
      actorId = owner.userId,
      conversationId = conversation.id,
      rowTenant = tenantId,
      provider = 'mock',
    ) => tx.$executeRaw`
      INSERT INTO outbound_intents(tenant_id,id,actor_id,request_id,conversation_id,content_text,provider_key)
      VALUES(${rowTenant}::uuid,${id}::uuid,${actorId}::uuid,${requestId}::uuid,
        ${conversationId}::uuid,${text},${provider})`;
    const id = randomUUID();
    const requestId = randomUUID();
    await scoped(runtime, tenantId, (tx) => insert(tx, requestId, id));
    // A distinct DB client sees committed data: this is not process-local mock state.
    const rows = await scoped(
      fresh,
      tenantId,
      (tx) => tx.$queryRaw<Array<{ id: string; content_text: string }>>`
      SELECT id,content_text FROM outbound_intents WHERE id=${id}::uuid`,
    );
    assert.deepEqual(rows, [{ id, content_text: 'Resposta de teste' }]);
    assert.deepEqual(await runtime.$queryRaw`SELECT id FROM outbound_intents`, []);
    assert.deepEqual(
      await scoped(
        runtime,
        otherTenantId,
        (tx) => tx.$queryRaw`SELECT id FROM outbound_intents WHERE id=${id}::uuid`,
      ),
      [],
    );
    await assert.rejects(
      scoped(runtime, otherTenantId, (tx) => insert(tx)),
      sqlError('42501'),
    );
    await assert.rejects(
      scoped(runtime, tenantId, (tx) =>
        insert(tx, randomUUID(), randomUUID(), 'test', otherOwner.userId),
      ),
      sqlError('23503'),
    );
    await assert.rejects(
      scoped(runtime, otherTenantId, (tx) =>
        insert(
          tx,
          randomUUID(),
          randomUUID(),
          'test',
          otherOwner.userId,
          conversation.id,
          otherTenantId,
        ),
      ),
      sqlError('23503'),
    );
    for (const text of ['', '   ', 'x'.repeat(4097)]) {
      await assert.rejects(
        scoped(runtime, tenantId, (tx) => insert(tx, randomUUID(), randomUUID(), text)),
        sqlError(text.length > 4096 ? '22001' : '23514'),
      );
    }
    await assert.rejects(
      scoped(runtime, tenantId, (tx) =>
        insert(
          tx,
          randomUUID(),
          randomUUID(),
          'test',
          owner.userId,
          conversation.id,
          tenantId,
          'whatsapp',
        ),
      ),
      sqlError('23514'),
    );
    await assert.rejects(
      scoped(
        runtime,
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE outbound_intents SET content_text='changed' WHERE id=${id}::uuid`,
      ),
      sqlError('42501'),
    );
    await assert.rejects(
      scoped(
        runtime,
        tenantId,
        (tx) => tx.$executeRaw`DELETE FROM outbound_intents WHERE id=${id}::uuid`,
      ),
      sqlError('42501'),
    );
    // Both identical and changed payloads must go through the future replay/conflict service.
    for (const text of ['Resposta de teste', 'different'])
      await assert.rejects(
        scoped(runtime, tenantId, (tx) => insert(tx, requestId, randomUUID(), text)),
        sqlError('23505'),
      );
    const concurrentKey = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => scoped(runtime, tenantId, (tx) => insert(tx, concurrentKey))),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of results)
      if (result.status === 'rejected') assert(sqlError('23505')(result.reason));
    const rollbackId = randomUUID();
    const rollback = new Error('intent rollback');
    await assert.rejects(
      scoped(runtime, tenantId, async (tx) => {
        await insert(tx, randomUUID(), rollbackId);
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.deepEqual(
      await scoped(
        fresh,
        tenantId,
        (tx) => tx.$queryRaw`SELECT id FROM outbound_intents WHERE id=${rollbackId}::uuid`,
      ),
      [],
    );
    const [security] = await admin.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`
      SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced
      FROM pg_class WHERE oid='public.outbound_intents'::regclass`;
    assert.deepEqual(security, { enabled: true, forced: true });
  } finally {
    await Promise.all([admin.$disconnect(), runtime.$disconnect(), fresh.$disconnect()]);
  }
}
