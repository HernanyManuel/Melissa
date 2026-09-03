import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantService } from '../src/tenancy/tenant.service';
import { OutboundHttpFixture, testOutboundHttp } from './outbound-http.integration';
import {
  MAX_MOCK_OUTBOUND_INTENTS,
  OutboundIntentService,
} from '../src/messaging/outbound-intent.service';

export async function testOutboundAcceptance(
  tenants: TenantService,
  tenantId: string,
  otherTenant: string,
  http: OutboundHttpFixture,
) {
  assert(process.env.MIGRATION_DATABASE_URL);
  const db = new PrismaClient({ datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } } });
  const service = new OutboundIntentService(tenants);
  const status = (expected: number) => (error: unknown) =>
    error instanceof HttpException && error.getStatus() === expected;
  const owner = await db.membership.findFirstOrThrow({ where: { tenantId, role: 'owner' } });
  try {
    const session = await db.session.findFirstOrThrow({
      where: { userId: owner.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    const actor = { userId: owner.userId, sessionId: session.id };
    const customer = await db.customer.create({
      data: {
        tenantId,
        displayName: 'Outbound test',
        phoneE164: `+351${randomInt(100000000, 999999999)}`,
      },
    });
    const channelId = randomUUID();
    const channel = await db.channelConnection.create({
      data: {
        id: channelId,
        tenantId,
        channelType: 'whatsapp',
        mode: 'mock',
        displayName: 'Outbound test',
        externalAccountId: `mock:${channelId}`,
        externalPhoneId: `mock:${channelId}`,
      },
    });
    const conversation = await db.conversation.create({
      data: {
        tenantId,
        customerId: customer.id,
        channelConnectionId: channel.id,
        lastMessageAt: new Date(),
      },
    });
    const input = {
      requestId: randomUUID(),
      conversationId: conversation.id,
      text: '  Olá 👋\nMensagem  ',
    };
    const before = await db.outboundIntent.count({ where: { tenantId } });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.acceptMock(actor, tenantId, input)),
    );
    assert.equal(new Set(results.map((r) => r.intentId)).size, 1);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert(results.every((r) => r.state === 'stored'));
    const id = results[0]!.intentId;
    assert.notEqual(id, input.requestId);
    assert.equal(
      (
        await service.acceptMock(actor, tenantId.toUpperCase(), {
          ...input,
          requestId: input.requestId.toUpperCase(),
          conversationId: input.conversationId.toUpperCase(),
        })
      ).intentId,
      id,
    );
    assert.equal(await db.outboundIntent.count({ where: { tenantId } }), before + 1);
    assert.equal(
      await db.auditEvent.count({
        where: { tenantId, targetId: id, action: 'outbound.intent_stored' },
      }),
      1,
    );
    assert.equal(
      (await db.outboundIntent.findUniqueOrThrow({ where: { id } })).contentText,
      input.text,
    );
    assert.deepEqual(Object.keys(results[0]!).sort(), ['duplicate', 'intentId', 'state']);
    for (const changed of [
      { ...input, text: 'different' },
      { ...input, conversationId: randomUUID() },
    ])
      await assert.rejects(service.acceptMock(actor, tenantId, changed), status(409));
    assert.equal(
      await db.auditEvent.count({
        where: { tenantId, targetId: id, action: 'outbound.intent_conflict' },
      }),
      2,
    );
    for (const text of ['', ' \n\t\u00a0', 'x'.repeat(4097), '\u0000', '\ud800'])
      await assert.rejects(
        service.acceptMock(actor, tenantId, { ...input, requestId: randomUUID(), text }),
        status(400),
      );
    await assert.rejects(
      service.acceptMock(actor, tenantId, { ...input, requestId: 'invalid' }),
      status(400),
    );
    await assert.rejects(service.acceptMock(actor, otherTenant, input), status(404));
    await assert.rejects(
      service.acceptMock({ ...actor, sessionId: randomUUID() }, tenantId, input),
      status(403),
    );
    for (const role of ['admin', 'manager', 'staff', 'viewer'] as const) {
      await db.membership.update({ where: { id: owner.id }, data: { role } });
      if (role === 'admin')
        assert.equal((await service.acceptMock(actor, tenantId, input)).duplicate, true);
      else await assert.rejects(service.acceptMock(actor, tenantId, input), status(403));
    }
    await db.membership.update({ where: { id: owner.id }, data: { role: 'owner', active: false } });
    await assert.rejects(service.acceptMock(actor, tenantId, input), status(404));
    await db.membership.update({ where: { id: owner.id }, data: { active: true } });
    const fresh = () => ({ ...input, requestId: randomUUID() });
    for (const change of [
      {
        mode: 'live',
        credentialsReference: 'test-reference',
        webhookSecretReference: 'test-reference',
      },
      { status: 'disconnected', disconnectedAt: new Date() },
      { channelType: 'webchat' },
    ]) {
      await db.channelConnection.update({
        where: { tenantId_id: { tenantId, id: channel.id } },
        data: change,
      });
      await assert.rejects(service.acceptMock(actor, tenantId, fresh()), status(404));
      // Replay reports historical storage, even after revocation; it does not send.
      assert.equal((await service.acceptMock(actor, tenantId, input)).intentId, id);
      await db.channelConnection.update({
        where: { tenantId_id: { tenantId, id: channel.id } },
        data: {
          mode: 'mock',
          status: 'active',
          channelType: 'whatsapp',
          disconnectedAt: null,
          credentialsReference: null,
          webhookSecretReference: null,
        },
      });
    }
    await db.customer.update({
      where: { tenantId_id: { tenantId, id: customer.id } },
      data: { deletedAt: new Date() },
    });
    await assert.rejects(service.acceptMock(actor, tenantId, fresh()), status(404));
    await db.customer.update({
      where: { tenantId_id: { tenantId, id: customer.id } },
      data: { deletedAt: null },
    });
    for (const change of [{ status: 'closed' }, { status: 'archived' }, { mode: 'CLOSED' }]) {
      await db.conversation.update({
        where: { tenantId_id: { tenantId, id: conversation.id } },
        data: change,
      });
      await assert.rejects(service.acceptMock(actor, tenantId, fresh()), status(404));
      await db.conversation.update({
        where: { tenantId_id: { tenantId, id: conversation.id } },
        data: { status: 'open', mode: 'AI_PAUSED' },
      });
    }
    // Inject audit failure on an isolated service instance, preserving the real transaction.
    const brokenTenants = Object.create(tenants) as TenantService;
    const failure = new Error('synthetic audit failure');
    brokenTenants.audit = () => {
      throw failure;
    };
    const rollbackInput = fresh();
    await assert.rejects(
      new OutboundIntentService(brokenTenants).acceptMock(actor, tenantId, rollbackInput),
      (error) => error === failure,
    );
    assert.equal(
      await db.outboundIntent.count({ where: { tenantId, requestId: rollbackInput.requestId } }),
      0,
    );
    await testOutboundHttp(db, tenantId, otherTenant, conversation.id, owner.id, http);
    const count = await db.outboundIntent.count({ where: { tenantId } });
    await db.outboundIntent.createMany({
      data: Array.from({ length: MAX_MOCK_OUTBOUND_INTENTS - count }, () => ({
        tenantId,
        actorId: actor.userId,
        requestId: randomUUID(),
        conversationId: conversation.id,
        contentText: 'Quota fixture',
      })),
    });
    await assert.rejects(service.acceptMock(actor, tenantId, fresh()), status(409));
    assert.equal((await service.acceptMock(actor, tenantId, input)).duplicate, true);
    assert.equal(
      await db.message.count({ where: { tenantId, conversationId: conversation.id } }),
      0,
    );
  } finally {
    await db.membership.update({ where: { id: owner.id }, data: { role: 'owner', active: true } });
    await db.$disconnect();
  }
}
