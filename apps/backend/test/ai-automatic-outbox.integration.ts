import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaAITurnLedgerRepository } from '../src/ai/ai-turn-ledger';
import { Dependencies } from '../src/dependencies';

export async function testAIAutomaticOutbox(tenantId: string, otherTenantId: string) {
  assert(process.env.MIGRATION_DATABASE_URL);
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
  });
  const runtime = new PrismaClient();
  const scoped = <T>(tenant: string, run: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return run(tx);
    });
  const repository = new PrismaAITurnLedgerRepository({ db: runtime } as Dependencies);
  try {
    const initial = await admin.conversation.findFirstOrThrow({ where: { tenantId } });
    await admin.conversation.update({
      where: { tenantId_id: { tenantId, id: initial.id } },
      data: { mode: 'AI_ACTIVE' },
    });
    const conversation = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: initial.id } },
    });
    const turnId = randomUUID();
    assert.equal(
      await repository.begin({
        tenantId,
        turnId,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        modeEpoch: conversation.modeEpoch,
        stateVersion: conversation.stateVersion,
      }),
      'started',
    );
    const finish = {
      tenantId,
      turnId,
      outcome: 'completed' as const,
      rounds: 1,
      toolCalls: 0,
      failureCode: null,
      providerKey: 'mock',
      modelKey: 'mock-v1',
      inputTokens: 8,
      outputTokens: 3,
      deliveryText: 'Resposta automática segura',
    };
    assert.equal(await repository.finish(finish), 'finished');
    assert.equal(await repository.finish(finish), 'already_finished');
    const intents = await scoped(
      tenantId,
      (tx) => tx.$queryRaw<Array<{ id: string; turn_id: string; content_text: string }>>`
        SELECT id, turn_id, content_text FROM ai_outbound_intents WHERE turn_id=${turnId}::uuid`,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.content_text, finish.deliveryText);
    assert.equal(
      (
        await runtime.$queryRaw<Array<{ id: string; tenant_id: string; state: string }>>`
          SELECT id, tenant_id, state FROM ai_outbound_dispatch WHERE id=${intents[0]!.id}::uuid`
      )[0]?.state,
      'pending',
    );
    assert.deepEqual(
      await scoped(
        otherTenantId,
        (tx) => tx.$queryRaw`SELECT id FROM ai_outbound_intents WHERE turn_id=${turnId}::uuid`,
      ),
      [],
    );

    const staleTurn = randomUUID();
    assert.equal(
      await repository.begin({
        tenantId,
        turnId: staleTurn,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        modeEpoch: conversation.modeEpoch,
        stateVersion: conversation.stateVersion,
      }),
      'started',
    );
    await admin.conversation.update({
      where: { tenantId_id: { tenantId, id: conversation.id } },
      data: { mode: 'AI_PAUSED' },
    });
    assert.equal(await repository.finish({ ...finish, turnId: staleTurn }), 'stale');
    const [stale] = await scoped(
      tenantId,
      (tx) => tx.$queryRaw<Array<{ status: string; outcome: string; intents: bigint }>>`
        SELECT t.status, u.outcome,
          (SELECT count(*) FROM ai_outbound_intents o WHERE o.turn_id=t.id) AS intents
        FROM ai_turns t JOIN ai_usage_events u
          ON u.tenant_id=t.tenant_id AND u.turn_id=t.id
        WHERE t.id=${staleTurn}::uuid`,
    );
    assert.deepEqual(stale, { status: 'stale', outcome: 'stale', intents: 0n });
    await assert.rejects(
      scoped(
        tenantId,
        (tx) => tx.$executeRaw`UPDATE ai_outbound_intents SET content_text='changed'
          WHERE turn_id=${turnId}::uuid`,
      ),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === '42501',
    );
  } finally {
    await Promise.all([runtime.$disconnect(), admin.$disconnect()]);
  }
}
