import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaAIAutomaticOutboundStore } from '../src/ai/ai-outbound-dispatcher';
import { PrismaAITurnLedgerRepository } from '../src/ai/ai-turn-ledger';
import { CONFIG, Configuration } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { configureHttp } from '../src/http';
import { IdentityMail } from '../src/identity/mail';
import { waitReady } from './wait-ready';

// prettier-ignore
test('human takeover fences automatic outbound and supports reactivation and close', { timeout: 30000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'conversation control integration requires MIGRATION_DATABASE_URL');

  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  const deps = app.get(Dependencies);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const verificationTokens = new Map<string, string>();

  app.get(IdentityMail).send = async (email, purpose, token) => {
    if (purpose === 'verify') verificationTokens.set(email, token);
  };
  configureHttp(app, config, false);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const call = (method: string, path: string, body?: object, bearer?: string) =>
    fetch(base + '/api/v1' + path, {
      method,
      headers: {
        Origin: config.CORS_ORIGIN,
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const data = async <T>(response: Response, status: number): Promise<T> => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<T>;
  };

  const createActor = async (label: string) => {
    const email = `conversation-control-${label}-${randomUUID()}@example.test`;
    const password = 'Conversation-control-123!';
    assert.equal(
      (
        await call('POST', '/auth/register', {
          email,
          password,
          name: label,
          termsAccepted: true,
        })
      ).status,
      202,
    );
    const token = verificationTokens.get(email);
    assert(token);
    assert.equal((await call('POST', '/auth/verify', { token })).status, 204);
    const login = await data<{ access_token: string }>(
      await call('POST', '/auth/login', { email, password }),
      200,
    );
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { ...login, userId: user.id };
  };

  try {
    await waitReady(base);
    const [owner, foreign] = await Promise.all([createActor('owner'), createActor('foreign')]);
    const tenant = await data<{ id: string }>(
      await call(
        'POST',
        '/tenants',
        { name: 'Conversation control', countryCode: 'PT', timezone: 'Europe/Lisbon' },
        owner.access_token,
      ),
      201,
    );
    const foreignTenant = await data<{ id: string }>(
      await call(
        'POST',
        '/tenants',
        { name: 'Foreign tenant', countryCode: 'PT', timezone: 'Europe/Lisbon' },
        foreign.access_token,
      ),
      201,
    );

    const staffId = randomUUID();
    const foreignStaffId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();

    await admin.staff.create({
      data: {
        tenantId: tenant.id,
        id: staffId,
        userId: owner.userId,
        name: 'Owner staff',
        active: true,
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.staff.create({
      data: {
        tenantId: foreignTenant.id,
        id: foreignStaffId,
        userId: foreign.userId,
        name: 'Foreign staff',
        active: true,
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.channelConnection.create({
      data: {
        tenantId: tenant.id,
        id: channelId,
        channelType: 'test',
        mode: 'live',
        externalAccountId: randomUUID(),
        externalPhoneId: randomUUID(),
        displayName: 'Live control channel',
      },
    });
    await admin.customer.create({
      data: {
        tenantId: tenant.id,
        id: customerId,
        displayName: 'Control customer',
        phoneE164: '+351910000321',
      },
    });
    await admin.conversation.create({
      data: {
        tenantId: tenant.id,
        id: conversationId,
        customerId,
        channelConnectionId: channelId,
        mode: 'AI_ACTIVE',
        lastMessageAt: new Date(),
      },
    });
    const before = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });

    const ledger = new PrismaAITurnLedgerRepository(deps);
    const turnId = randomUUID();
    assert.equal(
      await ledger.begin({
        tenantId: tenant.id,
        turnId,
        conversationId,
        customerId,
        modeEpoch: before.modeEpoch,
        stateVersion: before.stateVersion,
      }),
      'started',
    );
    assert.equal(
      await ledger.finish({
        tenantId: tenant.id,
        turnId,
        outcome: 'completed',
        rounds: 1,
        toolCalls: 0,
        failureCode: null,
        providerKey: 'mock',
        modelKey: 'mock-v1',
        inputTokens: 2,
        outputTokens: 2,
        deliveryText: 'Must be fenced after takeover',
      }),
      'finished',
    );
    const [intent] = await admin.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM ai_outbound_intents
      WHERE tenant_id=${tenant.id}::uuid AND turn_id=${turnId}::uuid
    `;
    assert(intent);

    const takeoverPath = `/tenants/${tenant.id}/conversations/${conversationId}/takeover`;
    assert.equal(
      (await call('POST', takeoverPath, { staffId }, foreign.access_token)).status,
      404,
    );
    assert.equal(
      (await call('POST', takeoverPath, { staffId: foreignStaffId }, owner.access_token)).status,
      404,
    );

    const taken = await data<{
      id: string;
      status: string;
      mode: string;
      assignedStaffId: string | null;
      closedAt: string | null;
    }>(await call('POST', takeoverPath, { staffId }, owner.access_token), 200);
    assert.equal(taken.id, conversationId);
    assert.equal(taken.status, 'open');
    assert.equal(taken.mode, 'HUMAN_ACTIVE');
    assert.equal(taken.assignedStaffId, staffId);
    assert.equal(taken.closedAt, null);

    const afterTakeover = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });
    assert.equal(afterTakeover.modeEpoch, before.modeEpoch + 1n);

    const dispatcherStore = new PrismaAIAutomaticOutboundStore(deps);
    assert.equal(await dispatcherStore.claim(intent.id, 0), null);
    const [dispatchAfterTakeover] = await admin.$queryRaw<Array<{ state: string }>>`
      SELECT state FROM ai_outbound_dispatch WHERE id=${intent.id}::uuid
    `;
    assert.equal(dispatchAfterTakeover?.state, 'rejected');

    const duplicateTakeover = await data<{ mode: string; assignedStaffId: string | null }>(
      await call('POST', takeoverPath, { staffId }, owner.access_token),
      200,
    );
    assert.equal(duplicateTakeover.mode, 'HUMAN_ACTIVE');
    assert.equal(duplicateTakeover.assignedStaffId, staffId);
    assert.equal(
      (
        await admin.conversation.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
        })
      ).modeEpoch,
      before.modeEpoch + 1n,
    );

    const reactivated = await data<{
      mode: string;
      assignedStaffId: string | null;
    }>(
      await call(
        'POST',
        `/tenants/${tenant.id}/conversations/${conversationId}/reactivate-ai`,
        undefined,
        owner.access_token,
      ),
      200,
    );
    assert.equal(reactivated.mode, 'AI_ACTIVE');
    assert.equal(reactivated.assignedStaffId, null);
    const afterReactivation = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });
    assert.equal(afterReactivation.modeEpoch, before.modeEpoch + 2n);

    const closed = await data<{
      status: string;
      mode: string;
      assignedStaffId: string | null;
      closedAt: string | null;
    }>(
      await call(
        'POST',
        `/tenants/${tenant.id}/conversations/${conversationId}/close`,
        undefined,
        owner.access_token,
      ),
      200,
    );
    assert.equal(closed.status, 'closed');
    assert.equal(closed.mode, 'CLOSED');
    assert.equal(closed.assignedStaffId, null);
    assert(closed.closedAt);

    const afterClose = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });
    assert.equal(afterClose.modeEpoch, before.modeEpoch + 3n);

    const closedAgain = await data<{ closedAt: string | null }>(
      await call(
        'POST',
        `/tenants/${tenant.id}/conversations/${conversationId}/close`,
        undefined,
        owner.access_token,
      ),
      200,
    );
    assert.equal(closedAgain.closedAt, closed.closedAt);
    assert.equal(
      (
        await admin.conversation.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
        })
      ).modeEpoch,
      before.modeEpoch + 3n,
    );

    assert.equal(
      (
        await call(
          'POST',
          `/tenants/${tenant.id}/conversations/${conversationId}/reactivate-ai`,
          undefined,
          owner.access_token,
        )
      ).status,
      409,
    );
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId: tenant.id, targetId: conversationId, action: 'conversation.takeover' },
      }),
      1,
    );
    assert.equal(
      await admin.auditEvent.count({
        where: {
          tenantId: tenant.id,
          targetId: conversationId,
          action: 'conversation.ai_reactivated',
        },
      }),
      1,
    );
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId: tenant.id, targetId: conversationId, action: 'conversation.closed' },
      }),
      1,
    );
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
