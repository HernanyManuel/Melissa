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
    const email = `cc-${label}-${randomUUID()}@example.test`;
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
        channelType: 'webchat',
        mode: 'live',
        externalAccountId: randomUUID(),
        externalPhoneId: randomUUID(),
        displayName: 'Live control channel',
        credentialsReference: 'secret://test/channel',
        webhookSecretReference: 'secret://test/webhook',
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
    const customerPath = `/tenants/${tenant.id}/conversations/${conversationId}/customer`;
    assert.equal(
      (await call('GET', customerPath, undefined, foreign.access_token)).status,
      404,
    );
    const customerProfile = await data<{
      item: { id: string; displayName: string; phoneE164: string; language: string };
    }>(await call('GET', customerPath, undefined, owner.access_token), 200);
    assert.equal(customerProfile.item.id, customerId);
    assert.equal(customerProfile.item.displayName, 'Control customer');
    assert.equal(customerProfile.item.phoneE164, '+351910000321');
    assert.equal(customerProfile.item.language, 'pt');
    assert.deepEqual(
      Object.keys(customerProfile.item).sort(),
      [
        'displayName', 'email', 'id', 'language', 'marketingConsentStatus',
        'notes', 'phoneE164', 'whatsappOptInStatus',
      ].sort(),
    );
    assert.equal(
      (await call('GET',
        `/tenants/${foreignTenant.id}/conversations/${conversationId}/customer`,
        undefined, foreign.access_token)).status,
      404,
    );

    const tagPath = `/tenants/${tenant.id}/conversation-tags`;
    const appliedPath = `/tenants/${tenant.id}/conversations/${conversationId}/tags`;
    assert.equal((await call('GET', appliedPath, undefined, foreign.access_token)).status, 404);
    assert.equal((await call('POST', tagPath, { name: '   ' }, owner.access_token)).status, 400);
    const createdTag = await data<{ item: { id: string; name: string }; duplicate: boolean }>(
      await call('POST', tagPath, { name: 'Prioridade' }, owner.access_token),
      200,
    );
    assert.equal(createdTag.item.name, 'Prioridade');
    assert.equal(createdTag.duplicate, false);
    assert.equal(
      (await data<{ duplicate: boolean }>(
        await call('POST', tagPath, { name: 'Prioridade' }, owner.access_token), 200,
      )).duplicate,
      true,
    );
    assert.equal(
      (await call('POST', appliedPath + '/' + createdTag.item.id, undefined,
        foreign.access_token)).status,
      404,
    );
    const attachedTag = await data<{ attached: boolean; duplicate: boolean }>(
      await call('POST', appliedPath + '/' + createdTag.item.id, undefined,
        owner.access_token),
      200,
    );
    assert.deepEqual(attachedTag, { attached: true, duplicate: false });
    const tags = await data<{ available: { id: string }[]; applied: string[] }>(
      await call('GET', appliedPath, undefined, owner.access_token), 200,
    );
    assert.equal(tags.available[0]?.id, createdTag.item.id);
    assert.deepEqual(tags.applied, [createdTag.item.id]);
    const catalog = await data<{ items: { id: string; name: string }[] }>(
      await call('GET', tagPath, undefined, owner.access_token), 200,
    );
    assert.deepEqual(catalog.items, [{ id: createdTag.item.id, name: createdTag.item.name }]);
    assert.equal((await call('GET', tagPath, undefined, foreign.access_token)).status, 404);
    const statusPath = `/tenants/${tenant.id}/conversations`;
    assert.deepEqual(
      (await data<{ items: { id: string }[] }>(
        await call('GET', statusPath + '?status=open', undefined, owner.access_token), 200,
      )).items.map((item) => item.id), [conversationId],
    );
    assert.deepEqual(
      (await data<{ items: unknown[] }>(
        await call('GET', statusPath + '?status=closed', undefined, owner.access_token), 200,
      )).items, [],
    );
    assert.equal((await call('GET', statusPath + '?status=archived',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?status=closed',
      undefined, foreign.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      `?status=closed&after=${conversationId}`, undefined, owner.access_token)).status, 404);
    const filteredPath = `/tenants/${tenant.id}/conversations?tagId=${createdTag.item.id}`;
    const filtered = await data<{ items: { id: string }[]; next: string | null }>(
      await call('GET', filteredPath, undefined, owner.access_token), 200,
    );
    assert.deepEqual(filtered.items.map((item) => item.id), [conversationId]);
    assert.equal(filtered.next, null);
    assert.deepEqual(
      (await data<{ items: { id: string }[] }>(
        await call('GET', filteredPath + '&status=open',
          undefined, owner.access_token), 200,
      )).items.map((item) => item.id), [conversationId],
    );
    assert.deepEqual(
      (await data<{ items: unknown[] }>(
        await call('GET', filteredPath + '&status=closed',
          undefined, owner.access_token), 200,
      )).items, [],
    );
    assert.equal((await data<{ items: unknown[] }>(
      await call('GET', filteredPath + '&q=not-matching', undefined, owner.access_token),
      200,
    )).items.length, 0);
    assert.equal((await data<{ items: { id: string }[] }>(
      await call('GET', filteredPath + '&q=Control', undefined, owner.access_token),
      200,
    )).items[0]?.id, conversationId);
    assert.equal((await call('GET', filteredPath, undefined, foreign.access_token)).status, 404);
    assert.equal((await call('GET',
      `/tenants/${tenant.id}/conversations?tagId=invalid`, undefined,
      owner.access_token)).status, 400);
    assert.equal((await call('GET',
      `/tenants/${tenant.id}/conversations?tagId=${randomUUID()}`, undefined,
      owner.access_token)).status, 404);
    assert.deepEqual(
      (await data<{ items: unknown[] }>(
        await call('GET', filteredPath + `&after=${conversationId}`, undefined,
          owner.access_token), 200,
      )).items, [],
    );
    assert.deepEqual(
      await data<{ attached: boolean; duplicate: boolean }>(
        await call('DELETE', appliedPath + '/' + createdTag.item.id, undefined,
          owner.access_token), 200,
      ),
      { attached: false, duplicate: false },
    );
    assert.equal((await admin.conversationTagLink.count({
      where: { tenantId: tenant.id, conversationId },
    })), 0);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', filteredPath, undefined, owner.access_token), 200,
    )).items, []);
    assert.equal((await admin.auditEvent.count({
      where: { tenantId: tenant.id, action: 'conversation.tag_attached' },
    })), 1);

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
    // Control-state triage is a read-only filter, not a takeover or dispatch.
    assert.equal((await call('GET', statusPath + '?controlMode=invalid',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?controlMode=HUMAN_ACTIVE',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?controlMode=human',
      undefined, foreign.access_token)).status, 404);
    assert.deepEqual((await data<{ items: Array<{ id: string }> }>(
      await call('GET', statusPath + '?controlMode=human&status=open',
        undefined, owner.access_token), 200,
    )).items.map((row) => row.id), [conversationId]);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath + '?controlMode=ai',
        undefined, owner.access_token), 200,
    )).items, []);
    assert.equal(taken.assignedStaffId, staffId);
    assert.equal(taken.closedAt, null);

    const afterTakeover = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });
    assert.equal(afterTakeover.modeEpoch, before.modeEpoch + 2n);

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
      before.modeEpoch + 2n,
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
    assert.deepEqual((await data<{ items: Array<{ id: string }> }>(
      await call('GET', statusPath + '?controlMode=ai',
        undefined, owner.access_token), 200,
    )).items.map((row) => row.id), [conversationId]);
    assert.equal((await call('GET', statusPath +
      '?controlMode=human&after=' + conversationId,
      undefined, owner.access_token)).status, 404);
    assert.equal(reactivated.assignedStaffId, null);
    const afterReactivation = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });
    assert.equal(afterReactivation.modeEpoch, before.modeEpoch + 3n);

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
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath + '?controlMode=human',
        undefined, owner.access_token), 200,
    )).items, []);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath + '?controlMode=ai&status=closed',
        undefined, owner.access_token), 200,
    )).items, []);
    assert.equal(closed.assignedStaffId, null);
    assert(closed.closedAt);
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      VALUES (${tenant.id}::uuid, 'message.received', ${conversationId}::uuid)
    `;
    const closedOnly = await data<{ items: { id: string; status: string }[]; next: string | null }>(
      await call('GET', statusPath + '?status=closed&unreadOnly=true',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(closedOnly.items.map((item) => item.id), [conversationId]);
    assert.equal(closedOnly.items[0]?.status, 'closed');
    assert.equal(closedOnly.next, null);
    assert.deepEqual(
      (await data<{ items: unknown[] }>(
        await call('GET', statusPath + '?status=open&unreadOnly=true',
          undefined, owner.access_token), 200,
      )).items, [],
    );
    assert.deepEqual(
      (await data<{ items: { id: string }[] }>(
        await call('GET', statusPath + '?status=closed',
          undefined, owner.access_token), 200,
      )).items.map((item) => item.id), [conversationId],
    );
    assert.deepEqual(
      (await data<{ items: unknown[] }>(
        await call('GET', statusPath + '?status=open',
          undefined, owner.access_token), 200,
      )).items, [],
    );
    assert.deepEqual(
      (await data<{ items: unknown[] }>(
        await call('GET', statusPath + `?status=closed&after=${conversationId}`,
          undefined, owner.access_token), 200,
      )).items, [],
    );

    const afterClose = await admin.conversation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: tenant.id, id: conversationId } },
    });
    assert.equal(afterClose.modeEpoch, before.modeEpoch + 4n);

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
      before.modeEpoch + 4n,
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

    // Channel mode is a read-only tenant-scoped filter, including unread SQL.
    assert.equal((await call('GET', statusPath + '?channelMode=invalid',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?channelMode=LIVE',
      undefined, owner.access_token)).status, 400);
    const liveModePage = await data<{ items: { id: string }[] }>(
      await call('GET', statusPath + '?channelMode=live',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(liveModePage.items.map((item) => item.id), [conversationId]);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath + '?channelMode=mock',
        undefined, owner.access_token), 200,
    )).items, []);
    assert.equal((await call('GET', statusPath + '?channelMode=mock',
      undefined, foreign.access_token)).status, 404);
    assert.equal((await call('GET', statusPath + '?channelMode=mock&after=' + conversationId,
      undefined, owner.access_token)).status, 404);
    assert.deepEqual((await data<{ items: { id: string }[] }>(
      await call('GET', statusPath + '?channelMode=live&status=closed&unreadOnly=true',
        undefined, owner.access_token), 200,
    )).items.map((item) => item.id), [conversationId]);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath + '?channelMode=mock&unreadOnly=true',
        undefined, owner.access_token), 200,
    )).items, []);
    const mockChannelId = randomUUID();
    const mockCustomerId = randomUUID();
    const mockConversationId = randomUUID();
    await admin.channelConnection.create({ data: {
      tenantId: tenant.id, id: mockChannelId, channelType: 'webchat', mode: 'mock',
      externalAccountId: `mock:${randomUUID()}`,
      externalPhoneId: `mock:${randomUUID()}`,
      displayName: 'Sandbox triage channel',
    } });
    await admin.customer.create({ data: {
      tenantId: tenant.id, id: mockCustomerId,
      displayName: 'Sandbox triage customer', phoneE164: '+351910000323',
    } });
    await admin.conversation.create({ data: {
      tenantId: tenant.id, id: mockConversationId,
      channelConnectionId: mockChannelId, customerId: mockCustomerId,
      lastMessageAt: new Date(),
    } });
    const mockPage = await data<{ items: { id: string }[]; next: string | null }>(
      await call('GET', statusPath + '?channelMode=mock',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(mockPage.items.map((item) => item.id), [mockConversationId]);
    assert.equal(mockPage.next, null);
    assert.equal((await call('GET', statusPath + '?channelMode=live&after=' + mockConversationId,
      undefined, owner.access_token)).status, 404);
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      VALUES (${tenant.id}::uuid, 'message.received', ${mockConversationId}::uuid)
    `;
    const mockUnread = await data<{ items: { id: string }[] }>(
      await call('GET', statusPath + '?channelMode=mock&unreadOnly=true',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(mockUnread.items.map((item) => item.id), [mockConversationId]);
    const combinedLive = await data<{ items: { id: string }[] }>(
      await call('GET', statusPath + '?channelMode=live&status=closed&unreadOnly=true',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(combinedLive.items.map((item) => item.id), [conversationId]);
    assert.equal((await call('GET', statusPath + '?channelId=bad',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?channelId=' + randomUUID(),
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath + '?channelId=' + mockChannelId,
      undefined, foreign.access_token)).status, 404);
    assert.deepEqual((await data<{ items: { id: string }[] }>(
      await call('GET', statusPath + '?channelId=' + mockChannelId,
        undefined, owner.access_token), 200,
    )).items.map((row) => row.id), [mockConversationId]);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath + '?channelId=' + mockChannelId + '&channelMode=live',
        undefined, owner.access_token), 200,
    )).items, []);
    assert.equal((await call('GET', statusPath +
      '?channelId=' + mockChannelId + '&after=' + conversationId,
      undefined, owner.access_token)).status, 404);
    assert.deepEqual((await data<{ items: { id: string }[] }>(
      await call('GET', statusPath + '?channelId=' + mockChannelId +
        '&channelMode=mock&status=open&unreadOnly=true',
        undefined, owner.access_token), 200,
    )).items.map((row) => row.id), [mockConversationId]);
    // Customer context is bounded and cross-channel, never cross-customer.
    // Add the related records only after conversation-list filter assertions.
    const otherCustomerId = randomUUID();
    await admin.customer.create({
      data: {
        tenantId: tenant.id,
        id: otherCustomerId,
        displayName: 'Unrelated customer',
        phoneE164: '+351910000322',
      },
    });
    const relatedIds: string[] = [];
    for (let index = 0; index < 7; index++) {
      const otherChannelId = randomUUID();
      const otherConversationId = randomUUID();
      await admin.channelConnection.create({
        data: {
          tenantId: tenant.id,
          id: otherChannelId,
          channelType: 'webchat',
          mode: 'live',
          externalAccountId: randomUUID(),
          externalPhoneId: randomUUID(),
          displayName: `Related channel ${index}`,
          credentialsReference: 'secret://test/related-channel',
          webhookSecretReference: 'secret://test/related-webhook',
        },
      });
      await admin.conversation.create({
        data: {
          tenantId: tenant.id,
          id: otherConversationId,
          customerId: index === 6 ? otherCustomerId : customerId,
          channelConnectionId: otherChannelId,
          mode: 'AI_ACTIVE',
          lastMessageAt: new Date(Date.UTC(2026, 9, 9, index)),
        },
      });
      if (index < 6) relatedIds.push(otherConversationId);
    }
    const detailed = await data<{
      item: { id: string };
      relatedConversations: {
        items: Array<{ id: string; status: string; lastMessageAt: string; channelName: string }>;
        hasMore: boolean;
      };
    }>(await call('GET', customerPath, undefined, owner.access_token), 200);
    assert.equal(detailed.item.id, customerId);
    assert.equal(detailed.relatedConversations.items.length, 5);
    assert.equal(detailed.relatedConversations.hasMore, true);
    assert.deepEqual(
      detailed.relatedConversations.items.map((row) => row.id),
      relatedIds.slice(1).reverse(),
    );
    for (const row of detailed.relatedConversations.items) {
      assert.equal(row.status, 'open');
      assert.match(row.channelName, /^Related channel [1-5]$/);
      assert(!Object.keys(row).includes('state'));
      assert(!Object.keys(row).includes('contentText'));
    }
    assert.equal(
      (await call('GET', customerPath, undefined, foreign.access_token)).status,
      404,
    );
    // Catalog is messages:read-only: no provider IDs, credentials, or unrelated tenants.
    const optionsPath = `/tenants/${tenant.id}/inbox/channel-options`;
    assert.equal((await call('GET', optionsPath, undefined, foreign.access_token)).status, 404);
    assert.equal((await call('GET', optionsPath + '?after=bad',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', optionsPath + '?after=' + randomUUID(),
      undefined, owner.access_token)).status, 404);
    const viewer = await createActor('viewer');
    await admin.membership.create({
      data: { tenantId: tenant.id, userId: viewer.userId, role: 'viewer' },
    });
    assert.equal((await call('GET', optionsPath, undefined, viewer.access_token)).status, 403);
    const initialOptions = await data<{ items: Array<{
      id: string; displayName: string; mode: string;
    }>; next: string | null }>(
      await call('GET', optionsPath, undefined, owner.access_token), 200,
    );
    assert.equal(initialOptions.items.length, 9);
    assert.equal(initialOptions.next, null);
    assert(initialOptions.items.some((item) => item.id === mockChannelId && item.mode === 'mock'));
    for (const item of initialOptions.items) {
      assert.deepEqual(Object.keys(item).sort(), ['displayName', 'id', 'mode']);
    }
    const extra = Array.from({ length: 51 }, (_, index) => ({
      channelId: randomUUID(), customerId: randomUUID(), conversationId: randomUUID(),
      index,
    }));
    await admin.channelConnection.createMany({ data: extra.map((item) => ({
      tenantId: tenant.id, id: item.channelId, channelType: 'webchat',
      mode: 'mock', externalAccountId: `mock:${item.channelId}`,
      externalPhoneId: `mock:${item.channelId}`,
      displayName: `Channel option ${item.index}`,
    })) });
    await admin.customer.createMany({ data: extra.map((item) => ({
      tenantId: tenant.id, id: item.customerId,
      displayName: `Catalog person ${item.index}`,
      phoneE164: `+351931${String(item.index).padStart(6, '0')}`,
    })) });
    await admin.conversation.createMany({ data: extra.map((item) => ({
      tenantId: tenant.id, id: item.conversationId,
      customerId: item.customerId, channelConnectionId: item.channelId,
      lastMessageAt: new Date(),
    })) });
    const firstOptions = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', optionsPath, undefined, owner.access_token), 200,
    );
    assert.equal(firstOptions.items.length, 50);
    assert.equal(firstOptions.next, firstOptions.items[49]?.id);
    const moreOptions = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', optionsPath + '?after=' + firstOptions.next,
        undefined, owner.access_token), 200,
    );
    assert.equal(moreOptions.items.length, 10);
    assert.equal(moreOptions.next, null);
    const allIds = [...firstOptions.items, ...moreOptions.items].map((item) => item.id);
    assert.equal(new Set(allIds).size, 60);
    assert.deepEqual(allIds, [...allIds].sort());
    const lastChannel = extra[50]!;
    const narrow = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', statusPath + '?channelId=' + lastChannel.channelId,
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(narrow.items.map((row) => row.id), [lastChannel.conversationId]);
    assert.equal(narrow.next, null);
    // The paused subset is selected before LIMIT 51, not from an already
    // sliced page; after-cursors belong to the chosen control state.
    const firstPaused = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', statusPath + '?controlMode=paused',
        undefined, owner.access_token), 200,
    );
    assert.equal(firstPaused.items.length, 50);
    assert(firstPaused.next);
    const remainingPaused = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', statusPath + '?controlMode=paused&after=' + firstPaused.next,
        undefined, owner.access_token), 200,
    );
    const pausedIds = [...firstPaused.items, ...remainingPaused.items].map((row) => row.id);
    assert.equal(pausedIds.length, 52);
    assert.equal(new Set(pausedIds).size, 52);
    assert.deepEqual(pausedIds, [...pausedIds].sort());
    assert.equal(remainingPaused.next, null);
    assert.equal((await call('GET', statusPath +
      '?controlMode=paused&after=' + conversationId,
      undefined, owner.access_token)).status, 404);
    assert.deepEqual((await data<{ items: Array<{ id: string }> }>(
      await call('GET', statusPath +
        '?controlMode=paused&unreadOnly=true&channelId=' + mockChannelId,
        undefined, owner.access_token), 200,
    )).items.map((row) => row.id), [mockConversationId]);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', statusPath +
        '?controlMode=ai&unreadOnly=true&channelId=' + mockChannelId,
        undefined, owner.access_token), 200,
    )).items, []);
    // ADR-100: same timestamp requires an ID tie-breaker across a 50-row
    // boundary. Keep default ID order unchanged and test both SQL paths.
    assert.equal((await call('GET', statusPath + '?sort=RECENT',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?sort=latest',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath + '?sort=recent',
      undefined, foreign.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?sort=recent&controlMode=paused&after=' + conversationId,
      undefined, owner.access_token)).status, 404);
    const tieAt = new Date('2030-01-01T12:00:00.000Z');
    await admin.conversation.updateMany({
      where: { tenantId: tenant.id, id: { in: extra.map((item) => item.conversationId) } },
      data: { lastMessageAt: tieAt },
    });
    await admin.conversation.update({
      where: { tenantId_id: { tenantId: tenant.id, id: mockConversationId } },
      data: { lastMessageAt: new Date('2029-01-01T00:00:00.000Z') },
    });
    const orderPath = statusPath + '?sort=recent&controlMode=paused&channelMode=mock';
    const expectedRecentIds = [
      ...extra.map((item) => item.conversationId).sort().reverse(), mockConversationId,
    ];
    const recentFirst = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', orderPath, undefined, owner.access_token), 200,
    );
    assert.deepEqual(recentFirst.items.map((row) => row.id), expectedRecentIds.slice(0, 50));
    assert.equal(recentFirst.next, expectedRecentIds[49]);
    const recentLast = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', orderPath + '&after=' + recentFirst.next,
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(recentLast.items.map((row) => row.id), expectedRecentIds.slice(50));
    assert.equal(recentLast.next, null);
    const defaultId = await data<{ items: Array<{ id: string }> }>(
      await call('GET', statusPath + '?sort=id&controlMode=paused&channelMode=mock',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(defaultId.items.map((row) => row.id),
      [...expectedRecentIds].sort().slice(0, 50));
    // The SQL unread branch must select *and order* before LIMIT. 51 fresh
    // synthetic inbound events turn all tie rows unread for this actor.
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      SELECT c.tenant_id, 'message.received', c.id
      FROM conversations c
      JOIN channel_connections ch
        ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_connection_id
      WHERE c.tenant_id=${tenant.id}::uuid AND ch.display_name LIKE 'Channel option %'
    `;
    const unreadPath = orderPath + '&unreadOnly=true&status=open';
    const unreadFirst = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', unreadPath, undefined, owner.access_token), 200,
    );
    assert.deepEqual(unreadFirst.items.map((row) => row.id), expectedRecentIds.slice(0, 50));
    assert.equal(unreadFirst.next, expectedRecentIds[49]);
    const unreadLast = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', unreadPath + '&after=' + unreadFirst.next,
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(unreadLast.items.map((row) => row.id), expectedRecentIds.slice(50));
    assert.equal(unreadLast.next, null);
    // ADR-101: cursor membership includes assignment, literal search and
    // per-actor unread state, for BOTH default/recent orders and SQL/Prisma.
    const cursor = mockConversationId;
    assert.equal((await call('GET', statusPath +
      '?assignment=mine&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?sort=recent&assignment=mine&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?q=nonmatching&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?sort=recent&q=nonmatching&unreadOnly=true&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?q=Sandbox&unreadOnly=true&after=' + cursor,
      undefined, owner.access_token)).status, 200);
    await admin.conversation.update({
      where: { tenantId_id: { tenantId: tenant.id, id: cursor } },
      data: { assignedStaffId: staffId },
    });
    assert.equal((await call('GET', statusPath +
      '?assignment=unassigned&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?sort=recent&assignment=mine&q=Sandbox&after=' + cursor,
      undefined, owner.access_token)).status, 200);
    assert.equal((await call('GET', statusPath +
      '?unreadOnly=true&assignment=mine&after=' + cursor,
      undefined, owner.access_token)).status, 200);
    const latestInbound = await admin.inboxEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, conversationId: cursor, eventType: 'message.received' },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    await admin.inboxReadCursor.upsert({
      where: { tenantId_actorId_conversationId: {
        tenantId: tenant.id, actorId: owner.userId, conversationId: cursor,
      } },
      create: { tenantId: tenant.id, actorId: owner.userId,
        conversationId: cursor, lastReadSequence: latestInbound.sequence },
      update: { lastReadSequence: latestInbound.sequence },
    });
    assert.equal((await call('GET', statusPath +
      '?unreadOnly=true&assignment=mine&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?sort=recent&unreadOnly=true&assignment=mine&after=' + cursor,
      undefined, owner.access_token)).status, 404);
    assert.equal((await call('GET', statusPath +
      '?unreadOnly=true&assignment=mine',
      undefined, owner.access_token)).status, 200);
    assert.equal((await call('GET', statusPath +
      '?assignment=mine&after=' + cursor,
      undefined, owner.access_token)).status, 200);
    // ADR-102: one UTC threshold is stable across page 1, page 2 and
    // unread SQL. Exactly-equal timestamps belong to the filtered set.
    const cutoff = '2030-01-01T12:00:00.000Z';
    const activePath = statusPath +
      '?activitySince=' + cutoff + '&sort=recent&controlMode=paused&channelMode=mock';
    assert.equal((await call('GET', statusPath + '?activitySince=invalid',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath +
      '?activitySince=2030-02-31T00:00:00.000Z',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath +
      '?activitySince=2030-01-01T12:00:00Z',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', statusPath +
      '?activitySince=2030-01-01T12:00:00.000%2B01:00',
      undefined, owner.access_token)).status, 400);
    assert.equal((await call('GET', activePath,
      undefined, foreign.access_token)).status, 404);
    assert.equal((await call('GET', activePath + '&after=' + mockConversationId,
      undefined, owner.access_token)).status, 404);
    const recentActive = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', activePath, undefined, owner.access_token), 200,
    );
    assert.deepEqual(recentActive.items.map((row) => row.id), expectedRecentIds.slice(0, 50));
    assert.equal(recentActive.next, expectedRecentIds[49]);
    const recentActiveLast = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', activePath + '&after=' + recentActive.next,
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(recentActiveLast.items.map((row) => row.id),
      expectedRecentIds.slice(50, 51));
    assert.equal(recentActiveLast.next, null);
    const activeId = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', statusPath +
        '?activitySince=' + cutoff + '&controlMode=paused&channelMode=mock',
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(activeId.items.map((row) => row.id),
      [...expectedRecentIds.slice(0, 51)].sort().slice(0, 50));
    const activeUnreadPath = activePath + '&unreadOnly=true';
    const activeUnread = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', activeUnreadPath, undefined, owner.access_token), 200,
    );
    assert.deepEqual(activeUnread.items.map((row) => row.id), expectedRecentIds.slice(0, 50));
    assert.equal(activeUnread.next, expectedRecentIds[49]);
    const activeUnreadLast = await data<{ items: Array<{ id: string }>; next: string | null }>(
      await call('GET', activeUnreadPath + '&after=' + activeUnread.next,
        undefined, owner.access_token), 200,
    );
    assert.deepEqual(activeUnreadLast.items.map((row) => row.id),
      expectedRecentIds.slice(50, 51));
    assert.equal(activeUnreadLast.next, null);
    assert.deepEqual((await data<{ items: unknown[] }>(
      await call('GET', activePath.replace(cutoff, '2031-01-01T00:00:00.000Z'),
        undefined, owner.access_token), 200,
    )).items, []);
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
