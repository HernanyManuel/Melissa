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
        channelType: 'test',
        mode: 'live',
        externalAccountId: randomUUID(),
        externalPhoneId: randomUUID(),
        displayName: 'Inbox SSE channel',
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
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
