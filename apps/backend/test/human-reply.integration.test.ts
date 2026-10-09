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

// prettier-ignore
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

    const latestPath = `${controlPath}/manual-replies/latest`;
    assert.deepEqual(
      await data<{ item: null }>(await call('GET', latestPath, undefined, owner.access_token), 200),
      { item: null },
    );
    assert.equal((await call('GET', latestPath, undefined, foreign.access_token)).status, 404);
    const preparePath = `${controlPath}/manual-replies/prepare`;
    const preparedRequestId = randomUUID();
    const preparedText = 'Preparada e confirmada separadamente';
    const prepared = await data<{ intentId: string; duplicate: boolean; state: string }>(
      await call('POST', preparePath, { requestId: preparedRequestId, text: preparedText },
        owner.access_token),
      200,
    );
    assert.equal(prepared.state, 'prepared');
    assert.equal(prepared.duplicate, false);
    assert.equal(
      await admin.humanOutboundDispatch.findUnique({ where: { id: prepared.intentId } }),
      null,
    );
    const preparedRecovery = (await data<{
      item: { intentId: string; requestId: string; text: string; state: string };
    }>(await call('GET', latestPath, undefined, owner.access_token), 200)).item;
    assert.equal(preparedRecovery.intentId, prepared.intentId);
    assert.equal(preparedRecovery.requestId, preparedRequestId);
    assert.equal(preparedRecovery.text, preparedText);
    assert.equal(preparedRecovery.state, 'prepared');
    const repeatedPrep = await data<{ intentId: string; duplicate: boolean; state: string }>(
      await call('POST', preparePath, { requestId: preparedRequestId, text: preparedText },
        owner.access_token),
      200,
    );
    assert.equal(repeatedPrep.intentId, prepared.intentId);
    assert.equal(repeatedPrep.duplicate, true);
    assert.equal(repeatedPrep.state, 'prepared');
    assert.equal(
      (await call('POST', preparePath,
        { requestId: preparedRequestId, text: 'outro texto' }, owner.access_token)).status,
      409,
    );
    const confirmed = await data<{ intentId: string; duplicate: boolean; state: string }>(
      await call('POST', `${controlPath}/messages`,
        { requestId: preparedRequestId, text: preparedText }, owner.access_token),
      200,
    );
    assert.equal(confirmed.intentId, prepared.intentId);
    assert.equal(confirmed.duplicate, true);
    assert.equal(confirmed.state, 'pending');
    assert.equal(
      (await admin.humanOutboundDispatch.findUniqueOrThrow({
        where: { id: prepared.intentId },
      })).state,
      'pending',
    );

    const abandonPath = `${controlPath}/manual-replies/abandon`;
    assert.equal(
      (await call('POST', abandonPath, { requestId: preparedRequestId }, owner.access_token)).status,
      409,
    );

    const abandonedRequestId = randomUUID();
    const abandoned = await data<{ intentId: string; state: string }>(
      await call('POST', preparePath,
        { requestId: abandonedRequestId, text: 'Nunca será enviada' }, owner.access_token),
      200,
    );
    assert.equal(abandoned.state, 'prepared');
    assert.equal(
      (await call('POST', abandonPath, { requestId: abandonedRequestId },
        foreign.access_token)).status,
      404,
    );
    const abandonedResult = await data<{ intentId: string; state: string; duplicate: boolean }>(
      await call('POST', abandonPath, { requestId: abandonedRequestId }, owner.access_token),
      200,
    );
    assert.equal(abandonedResult.intentId, abandoned.intentId);
    assert.equal(abandonedResult.state, 'abandoned');
    assert.equal(abandonedResult.duplicate, false);
    const abandonedReplay = await data<{ state: string; duplicate: boolean }>(
      await call('POST', abandonPath, { requestId: abandonedRequestId }, owner.access_token),
      200,
    );
    assert.equal(abandonedReplay.state, 'abandoned');
    assert.equal(abandonedReplay.duplicate, true);
    assert.equal(
      (await call('POST', `${controlPath}/messages`,
        { requestId: abandonedRequestId, text: 'Nunca será enviada' },
        owner.access_token)).status,
      409,
    );
    assert.equal(
      (await data<{ state: string }>(
        await call('POST', preparePath,
          { requestId: abandonedRequestId, text: 'Nunca será enviada' },
          owner.access_token),
        200,
      )).state,
      'abandoned',
    );
    assert.equal(
      (await data<{ item: { state: string } }>(
        await call('GET', latestPath, undefined, owner.access_token),
        200,
      )).item.state,
      'abandoned',
    );
    assert.equal(
      await admin.humanOutboundDispatch.findUnique({ where: { id: abandoned.intentId } }),
      null,
    );

    const expiredRequestId = randomUUID();
    const expired = await data<{ intentId: string; state: string }>(
      await call('POST', preparePath,
        { requestId: expiredRequestId, text: 'Válida só durante 24 horas' },
        owner.access_token),
      200,
    );
    assert.equal(expired.state, 'prepared');
    await admin.humanOutboundIntent.update({
      where: { tenantId_id: { tenantId: tenant.id, id: expired.intentId } },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    assert.equal(
      (await data<{ item: { state: string } }>(
        await call('GET', latestPath, undefined, owner.access_token), 200,
      )).item.state,
      'expired',
    );
    assert.equal(
      (await data<{ state: string }>(
        await call('POST', preparePath,
          { requestId: expiredRequestId, text: 'Válida só durante 24 horas' },
          owner.access_token), 200,
      )).state,
      'expired',
    );
    assert.equal(
      (await call('POST', `${controlPath}/messages`,
        { requestId: expiredRequestId, text: 'Válida só durante 24 horas' },
        owner.access_token)).status,
      409,
    );
    assert.equal(
      await admin.humanOutboundDispatch.findUnique({ where: { id: expired.intentId } }),
      null,
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
    const latestResponse = await data<{
      item: { intentId: string; requestId: string; text: string; state: string };
    }>(await call('GET', latestPath, undefined, owner.access_token), 200);
    const latest = latestResponse.item;
    assert.deepEqual(
      { intentId: latest.intentId, requestId: latest.requestId, text: latest.text, state: latest.state },
      { intentId: first.intentId, requestId: firstRequestId, text: firstText, state: 'pending' },
    );
    assert.equal(Object.keys(latest).sort().join(','), 'createdAt,intentId,requestId,state,text');
    await admin.membership.create({
      data: { tenantId: tenant.id, userId: foreign.userId, role: 'staff' },
    });
    assert.deepEqual(
      await data<{ item: null }>(await call('GET', latestPath, undefined, foreign.access_token), 200),
      { item: null },
    );
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
          { requestId: randomUUID(), text: 'unassigned staff' },
          foreign.access_token,
        )
      ).status,
      403,
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
    const latestAfterSecond = (await data<{ item: { intentId: string; text: string; state: string } }>(
      await call('GET', latestPath, undefined, owner.access_token),
      200,
    )).item;
    assert.equal(latestAfterSecond.intentId, second.intentId);
    assert.equal(latestAfterSecond.text, 'Será invalidada pela reativação');
    assert.equal(latestAfterSecond.state, 'pending');
    const staleRequestId = randomUUID();
    const stalePrepared = await data<{ intentId: string; state: string }>(
      await call('POST', preparePath,
        { requestId: staleRequestId, text: 'Preparada antes da troca de modo' },
        owner.access_token),
      200,
    );
    assert.equal(stalePrepared.state, 'prepared');

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
    const afterReactivation = (await data<{ item: { intentId: string; state: string } }>(
      await call('GET', latestPath, undefined, owner.access_token),
      200,
    )).item;
    assert.equal(afterReactivation.intentId, stalePrepared.intentId);
    assert.equal(afterReactivation.state, 'prepared');
    assert.equal(
      (await call('POST', `${controlPath}/messages`,
        { requestId: staleRequestId, text: 'Preparada antes da troca de modo' },
        owner.access_token)).status,
      409,
    );
    assert.equal(
      await admin.humanOutboundDispatch.findUnique({ where: { id: stalePrepared.intentId } }),
      null,
    );

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
