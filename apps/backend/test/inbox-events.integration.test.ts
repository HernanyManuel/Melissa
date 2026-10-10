import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { configureHttp } from '../src/http';
import { IdentityMail } from '../src/identity/mail';
import { waitReady } from './wait-ready';

interface SseEvent {
  id: string;
  event: string;
  data: {
    conversationId: string;
    messageId: string | null;
    createdAt: string;
  };
}

async function readSseEvent(response: Response): Promise<SseEvent> {
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE stream ended before an event');
      buffer += decoder.decode(chunk.value, { stream: true });

      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!frame.includes('data:')) continue;

        const fields = new Map<string, string>();
        for (const line of frame.split('\n')) {
          const separator = line.indexOf(':');
          if (separator < 0) continue;
          fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
        }
        const id = fields.get('id');
        const event = fields.get('event');
        const data = fields.get('data');
        assert(id && event && data);
        return { id, event, data: JSON.parse(data) as SseEvent['data'] };
      }
    }
  } finally {
    await reader.cancel();
  }
}

// prettier-ignore
test('Inbox SSE replays missed tenant events without cross-tenant access', { timeout: 30000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'Inbox SSE integration requires MIGRATION_DATABASE_URL');

  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  const verificationTokens = new Map<string, string>();

  app.get(IdentityMail).send = async (email, purpose, token) => {
    if (purpose === 'verify') verificationTokens.set(email, token);
  };
  configureHttp(app, config, false);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const call = (method: string, path: string, body?: object, bearer?: string, headers?: HeadersInit) =>
    fetch(base + '/api/v1' + path, {
      method,
      headers: {
        Origin: config.CORS_ORIGIN,
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });

  const data = async <T>(response: Response, status: number): Promise<T> => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<T>;
  };

  const createActor = async (label: string) => {
    const email = `inbox-sse-${label}-${randomUUID()}@example.test`;
    const password = 'Inbox-sse-123!';
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
        { name: 'Inbox SSE', countryCode: 'PT', timezone: 'Europe/Lisbon' },
        owner.access_token,
      ),
      201,
    );
    await data<{ id: string }>(
      await call(
        'POST',
        '/tenants',
        { name: 'Foreign SSE', countryCode: 'PT', timezone: 'Europe/Lisbon' },
        foreign.access_token,
      ),
      201,
    );

    const staffId = randomUUID();
    const channelId = randomUUID();
    const customerId = randomUUID();
    const conversationId = randomUUID();
    await admin.staff.create({
      data: {
        tenantId: tenant.id,
        id: staffId,
        userId: owner.userId,
        name: 'Inbox operator',
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
        displayName: 'Inbox SSE channel',
        credentialsReference: 'secret://test/channel',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.customer.create({
      data: {
        tenantId: tenant.id,
        id: customerId,
        displayName: 'Inbox SSE customer',
        phoneE164: '+351910000654',
      },
    });
    await admin.conversation.create({
      data: {
        tenantId: tenant.id,
        id: conversationId,
        customerId,
        channelConnectionId: channelId,
        mode: 'WAITING_HUMAN',
        lastMessageAt: new Date(),
      },
    });

    const notePath = `/tenants/${tenant.id}/conversations/${conversationId}/internal-notes`;
    assert.deepEqual(
      await data<{ items: []; next: null }>(
        await call('GET', notePath, undefined, owner.access_token), 200,
      ),
      { items: [], next: null },
    );
    assert.equal((await call('GET', notePath, undefined, foreign.access_token)).status, 404);
    const noteRequest = { requestId: randomUUID(), text: 'Apenas para a equipa' };
    const firstNote = await data<{
      item: { id: string; text: string; actorId: string }; duplicate: boolean;
    }>(await call('POST', notePath, noteRequest, owner.access_token), 200);
    assert.equal(firstNote.duplicate, false);
    assert.equal(firstNote.item.text, noteRequest.text);
    assert.equal(firstNote.item.actorId, owner.userId);
    const repeatedNote = await data<{ item: { id: string }; duplicate: boolean }>(
      await call('POST', notePath, noteRequest, owner.access_token), 200,
    );
    assert.equal(repeatedNote.duplicate, true);
    assert.equal(repeatedNote.item.id, firstNote.item.id);
    assert.equal(
      (await call('POST', notePath, {
        ...noteRequest, text: 'Outro texto',
      }, owner.access_token)).status, 409,
    );
    assert.equal(
      (await call('POST',
        `/tenants/${tenant.id}/conversations/${randomUUID()}/internal-notes`,
        noteRequest, owner.access_token)).status, 404,
    );
    assert.equal(
      (await call('POST', notePath, {
        requestId: randomUUID(), text: '  ',
      }, owner.access_token)).status, 400,
    );
    assert.equal((await call('POST', notePath, noteRequest, foreign.access_token)).status, 404);
    assert.equal(
      (await call('GET', `${notePath}?after=${randomUUID()}`, undefined,
        owner.access_token)).status, 404,
    );
    const noteList = await data<{
      items: Array<{ id: string; text: string; actorId: string }>; next: null;
    }>(await call('GET', notePath, undefined, owner.access_token), 200);
    assert.equal(noteList.items.length, 1);
    assert.equal(noteList.items[0]!.id, firstNote.item.id);
    assert.equal(noteList.items[0]!.text, noteRequest.text);
    assert.equal(noteList.next, null);
    assert.equal(await admin.message.count({ where: { tenantId: tenant.id } }), 0);
    assert.equal(
      await admin.auditEvent.count({
        where: { tenantId: tenant.id, targetId: firstNote.item.id,
          action: 'conversation.internal_note_created' },
      }),
      1,
    );
    const viewer = await createActor('viewer');
    await admin.membership.create({
      data: { tenantId: tenant.id, userId: viewer.userId, role: 'viewer' },
    });
    assert.equal((await call('GET', notePath, undefined, viewer.access_token)).status, 403);
    assert.equal((await call('POST', notePath,
      { requestId: randomUUID(), text: 'Sem permissão' },
      viewer.access_token)).status, 403);

    const controlPath = `/tenants/${tenant.id}/conversations/${conversationId}`;
    assert.equal(
      (await call('POST', `${controlPath}/takeover`, { staffId }, owner.access_token)).status,
      200,
    );

    const firstResponse = await call(
      'GET',
      `/tenants/${tenant.id}/inbox/events?after=0`,
      undefined,
      owner.access_token,
    );
    assert.equal(firstResponse.status, 200);
    assert.match(firstResponse.headers.get('content-type') ?? '', /^text\/event-stream/);
    const first = await readSseEvent(firstResponse);
    assert.equal(first.id, '1');
    assert.equal(first.event, 'conversation.takeover');
    assert.equal(first.data.conversationId, conversationId);
    assert.equal(first.data.messageId, null);

    assert.equal(
      (await call('POST', `${controlPath}/reactivate-ai`, undefined, owner.access_token)).status,
      200,
    );
    const replayResponse = await call(
      'GET',
      `/tenants/${tenant.id}/inbox/events`,
      undefined,
      owner.access_token,
      { 'Last-Event-ID': first.id },
    );
    assert.equal(replayResponse.status, 200);
    const replayed = await readSseEvent(replayResponse);
    assert.equal(replayed.id, '2');
    assert.equal(replayed.event, 'conversation.ai_reactivated');
    assert.equal(replayed.data.conversationId, conversationId);

    assert.equal(
      (
        await call(
          'GET',
          `/tenants/${tenant.id}/inbox/events?after=0`,
          undefined,
          foreign.access_token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          'GET',
          `/tenants/${tenant.id}/inbox/events`,
          undefined,
          owner.access_token,
          { 'Last-Event-ID': 'invalid' },
        )
      ).status,
      400,
    );
    // Unread is based on durable inbound Inbox events, not outbound/control
    // traffic, and each actor maintains an independent monotonic cursor.
    await admin.membership.create({
      data: { tenantId: tenant.id, userId: foreign.userId, role: 'staff' },
    });
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      VALUES (${tenant.id}::uuid, 'message.received', ${conversationId}::uuid)
    `;
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      VALUES (${tenant.id}::uuid, 'message.received', ${conversationId}::uuid)
    `;
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      VALUES (${tenant.id}::uuid, 'message.sent', ${conversationId}::uuid)
    `;
    const listPath = `/tenants/${tenant.id}/conversations`;
    const list = async (token: string) => {
      const response = await data<{ items: Array<{
        id: string; unreadCount: number; unreadUpTo: string | null;
      }> }>(await call('GET', listPath, undefined, token), 200);
      return response.items.find((row) => row.id === conversationId);
    };
    const ownerUnread = await list(owner.access_token);
    const foreignUnread = await list(foreign.access_token);
    assert(ownerUnread);
    assert.equal(ownerUnread.unreadCount, 2);
    assert.equal(ownerUnread.unreadUpTo, '4');
    assert.equal(foreignUnread?.unreadCount, 2);
    const readPath = `${controlPath}/read`;
    assert.equal(
      (await call('POST', readPath, { upTo: '5' }, owner.access_token)).status,
      409,
    ); // Event 5 is outbound: never a valid read watermark.
    assert.equal(
      (await call('POST', readPath, { upTo: '6' }, owner.access_token)).status,
      409,
    ); // An unobserved future sequence cannot suppress later messages.
    assert.equal(
      (await call('POST', readPath, { upTo: '0' }, owner.access_token)).status,
      400,
    );
    assert.equal(
      (await call('POST', readPath, { upTo: '4' }, undefined)).status,
      401,
    );
    assert.equal(
      (await call('POST', readPath, { upTo: '4' }, owner.access_token)).status,
      200,
    );
    assert.equal((await list(owner.access_token))?.unreadCount, 0);
    assert.equal((await list(foreign.access_token))?.unreadCount, 2);

    const duplicate = await data<{ unreadUpTo: string; duplicate: boolean }>(
      await call('POST', readPath, { upTo: '3' }, owner.access_token),
      200,
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.unreadUpTo, '4');
    assert.equal((await list(owner.access_token))?.unreadCount, 0);
    assert.equal(
      (await call('POST', readPath, { upTo: '4' }, foreign.access_token)).status,
      200,
    );
    assert.equal((await list(foreign.access_token))?.unreadCount, 0);

    const foreignTenant = await data<{ id: string }>(
      await call('POST', '/tenants', {
        name: 'Read isolated', countryCode: 'PT', timezone: 'Europe/Lisbon',
      }, foreign.access_token), 201,
    );
    assert.equal(
      (await call('POST', `/tenants/${foreignTenant.id}/conversations/${conversationId}/read`,
        { upTo: '4' }, foreign.access_token)).status,
      404,
    );
    const [cursor] = await admin.inboxReadCursor.findMany({
      where: { tenantId: tenant.id, actorId: owner.userId, conversationId },
    });
    assert.equal(cursor?.lastReadSequence, 4n);
    await admin.$executeRaw`
      INSERT INTO inbox_events (tenant_id, event_type, conversation_id)
      VALUES (${tenant.id}::uuid, 'message.received', ${conversationId}::uuid)
    `;
    assert.equal((await list(owner.access_token))?.unreadCount, 1);
    assert.equal((await list(foreign.access_token))?.unreadCount, 1);

    const unreadPage = async (token: string, params = '?unreadOnly=true') =>
      data<{ items: Array<{ id: string; unreadCount: number }>; next: string | null }>(
        await call('GET', listPath + params, undefined, token), 200,
      );
    assert.equal((await call('GET', listPath + '?unreadOnly=1', undefined,
      owner.access_token)).status, 400);
    assert.equal((await call('GET', listPath + '?unreadOnly=TRUE', undefined,
      owner.access_token)).status, 400);
    assert.equal((await unreadPage(owner.access_token, '?unreadOnly=false')).items.length, 1);
    assert.equal((await unreadPage(owner.access_token)).items[0]?.id, conversationId);
    assert.equal((await unreadPage(foreign.access_token)).items[0]?.id, conversationId);
    assert.equal((await call('GET', listPath + '?unreadOnly=true', undefined,
      viewer.access_token)).status, 403);

    const createdTag = await data<{ item: { id: string } }>(
      await call('POST', `/tenants/${tenant.id}/conversation-tags`,
        { name: 'Pendentes' }, owner.access_token), 200,
    );
    assert.equal(
      (await call('POST', `${controlPath}/tags/${createdTag.item.id}`,
        undefined, owner.access_token)).status, 200,
    );
    const combined = await unreadPage(owner.access_token,
      `?unreadOnly=true&tagId=${createdTag.item.id}&q=Inbox%20SSE`);
    assert.deepEqual(combined.items.map((item) => item.id), [conversationId]);
    assert.deepEqual((await unreadPage(owner.access_token,
      '?unreadOnly=true&q=sem%20correspond%C3%AAncia')).items, []);

    // Page selection is before LIMIT: 51 read conversations preceding the
    // one unread conversation must not hide it from the first unread page.
    const readCustomers = Array.from({ length: 51 }, (_, index) => ({
      tenantId: tenant.id,
      id: randomUUID(),
      displayName: `Já lida ${index}`,
      phoneE164: `+351930${String(index).padStart(6, '0')}`,
    }));
    await admin.customer.createMany({ data: readCustomers });
    await admin.conversation.createMany({
      data: readCustomers.map((customer, index) => ({
        tenantId: tenant.id,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        channelConnectionId: channelId,
        customerId: customer.id,
        lastMessageAt: new Date(),
      })),
    });
    const unreadAfterReadRows = await unreadPage(owner.access_token);
    assert.deepEqual(unreadAfterReadRows.items.map((item) => item.id), [conversationId]);
    assert.equal(unreadAfterReadRows.next, null);
    assert.equal(unreadAfterReadRows.items[0]?.unreadCount, 1);

    assert.equal(
      (await call('POST', readPath, { upTo: '7' }, owner.access_token)).status,
      200,
    );
    assert.deepEqual((await unreadPage(owner.access_token)).items, []);
    assert.equal((await unreadPage(foreign.access_token)).items[0]?.id, conversationId);

  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
