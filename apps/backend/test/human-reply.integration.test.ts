import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { MessagingProvider } from '../src/channels/messaging-provider';
import { MessagingProviderRegistry } from '../src/channels/messaging-provider-registry';
import { CONFIG, Configuration } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { configureHttp } from '../src/http';
import { IdentityMail } from '../src/identity/mail';
import {
  HumanOutboundDispatcher,
  PrismaHumanOutboundStore,
} from '../src/messaging/human-outbound-dispatcher';
import { waitReady } from './wait-ready';

test('manual reply is durable, fenced and persisted after provider acceptance', { timeout: 30000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'human reply integration requires MIGRATION_DATABASE_URL');

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
    const email = `human-reply-${label}-${randomUUID()}@example.test`;
    const password = 'Human-reply-123!';
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
        { name: 'Human reply', countryCode: 'PT', timezone: 'Europe/Lisbon' },
        owner.access_token,
      ),
      201,
    );
    await data<{ id: string }>(
      await call(
        'POST',
        '/tenants',
        { name: 'Foreign human reply', countryCode: 'PT', timezone: 'Europe/Lisbon' },
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
        name: 'Human operator',
        active: true,
        timezone: 'Europe/Lisbon',
      },
    });
    await admin.channelConnection.create({
      data: {
        tenantId: tenant.id,
        id: channelId,
        channelType: 'whatsapp',
        mode: 'live',
        externalAccountId: randomUUID(),
        externalPhoneId: '123456789012345',
        displayName: 'Human reply channel',
        credentialsReference: 'secret://test/whatsapp',
        webhookSecretReference: 'secret://test/webhook',
      },
    });
    await admin.customer.create({
      data: {
        tenantId: tenant.id,
        id: customerId,
        displayName: 'Human reply customer',
        phoneE164: '+351910000777',
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

    const firstRequestId = randomUUID();
    const firstText = 'Resposta manual confirmada';
    const first = await data<{
      intentId: string;
      duplicate: boolean;
      state: string;
    }>(
      await call(
        'POST',
        `${controlPath}/messages`,
        { requestId: firstRequestId, text: firstText },
        owner.access_token,
      ),
      200,
    );
    assert.equal(first.duplicate, false);
    assert.equal(first.state, 'pending');

    const replay = await data<{ intentId: string; duplicate: boolean; state: string }>(
      await call(
        'POST',
        `${controlPath}/messages`,
        { requestId: firstRequestId, text: firstText },
        owner.access_token,
      ),
      200,
    );
    assert.equal(replay.intentId, first.intentId);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.state, 'pending');
    assert.equal(
      (
        await call(
          'POST',
          `${controlPath}/messages`,
          { requestId: firstRequestId, text: 'payload diferente' },
          owner.access_token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          'POST',
          `${controlPath}/messages`,
          { requestId: randomUUID(), text: 'cross tenant' },
          foreign.access_token,
        )
      ).status,
      404,
    );

    const second = await data<{ intentId: string; duplicate: boolean; state: string }>(
      await call(
        'POST',
        `${controlPath}/messages`,
        { requestId: randomUUID(), text: 'Será invalidada pela reativação' },
        owner.access_token,
      ),
      200,
    );
    assert.equal(second.state, 'pending');

    let sends = 0;
    const provider: MessagingProvider = {
      key: 'whatsapp:live',
      sendText: async (input) => {
        sends += 1;
        assert.equal(input.recipientReference, '+351910000777');
        assert.equal(input.senderReference, '123456789012345');
        assert.equal(input.credentialsReference, 'secret://test/whatsapp');
        assert.equal(input.text, firstText);
        return { providerMessageId: 'wamid.integration.1', acceptedAt: new Date() };
      },
    };
    const lease = async (
      _key: string,
      work: (assertOwned: () => Promise<void>) => Promise<void>,
    ) => {
      await work(async () => undefined);
      return true;
    };
    const dispatcher = new HumanOutboundDispatcher(
      new PrismaHumanOutboundStore(deps),
      new MessagingProviderRegistry([provider]),
      undefined,
      lease,
    );
    await dispatcher.process(first.intentId, 0);
    assert.equal(sends, 1);

    const acceptedReplay = await data<{ intentId: string; duplicate: boolean; state: string }>(
      await call(
        'POST',
        `${controlPath}/messages`,
        { requestId: firstRequestId, text: firstText },
        owner.access_token,
      ),
      200,
    );
    assert.equal(acceptedReplay.intentId, first.intentId);
    assert.equal(acceptedReplay.duplicate, true);
    assert.equal(acceptedReplay.state, 'accepted');

    const history = await data<{
      items: Array<{
        contentText: string;
        direction: string;
        senderType: string;
        status: string;
        aiGenerated: boolean;
      }>;
    }>(
      await call('GET', `${controlPath}/messages`, undefined, owner.access_token),
      200,
    );
    assert.equal(history.items.length, 1);
    assert.deepEqual(
      {
        contentText: history.items[0]!.contentText,
        direction: history.items[0]!.direction,
        senderType: history.items[0]!.senderType,
        status: history.items[0]!.status,
        aiGenerated: history.items[0]!.aiGenerated,
      },
      {
        contentText: firstText,
        direction: 'outbound',
        senderType: 'staff',
        status: 'accepted',
        aiGenerated: false,
      },
    );

    const [sentEvent] = await admin.$queryRaw<
      Array<{ eventType: string; messageId: string | null }>
    >`
      SELECT event_type AS "eventType", message_id::text AS "messageId"
      FROM inbox_events
      WHERE tenant_id=${tenant.id}::uuid
        AND conversation_id=${conversationId}::uuid
        AND event_type='message.sent'
      ORDER BY sequence DESC
      LIMIT 1
    `;
    assert.equal(sentEvent?.eventType, 'message.sent');
    assert(sentEvent?.messageId);

    assert.equal(
      (await call('POST', `${controlPath}/reactivate-ai`, undefined, owner.access_token)).status,
      200,
    );
    await dispatcher.process(second.intentId, 0);
    assert.equal(sends, 1);
    const secondDispatch = await admin.humanOutboundDispatch.findUniqueOrThrow({
      where: { id: second.intentId },
    });
    assert.equal(secondDispatch.state, 'rejected');

    assert.equal(
      (
        await call(
          'POST',
          `${controlPath}/messages`,
          { requestId: randomUUID(), text: 'não pode responder em AI_ACTIVE' },
          owner.access_token,
        )
      ).status,
      409,
    );
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
