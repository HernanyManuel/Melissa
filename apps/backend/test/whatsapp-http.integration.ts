import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CONFIG, parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { configureHttp } from '../src/http';
import { WhatsAppWebhookController } from '../src/channels/whatsapp-http';

@Module({})
class WebhookTestModule {}

export async function testWhatsAppHttp(
  admin: PrismaClient,
  scope: {
    integration: string;
    account: string;
    phone: string;
    secret: string;
    tenantId: string;
    channelId: string;
  },
) {
  const token = 'synthetic-http-verify-token';
  const config = parseConfig({
    ...process.env,
    WHATSAPP_WEBHOOK_ENABLED: 'false',
    WHATSAPP_INTEGRATION_KEY: scope.integration,
    WHATSAPP_APP_SECRET: scope.secret,
    WHATSAPP_VERIFY_TOKEN: token,
  });
  const app = await NestFactory.create(
    {
      module: WebhookTestModule,
      controllers: [WhatsAppWebhookController],
      providers: [{ provide: CONFIG, useValue: config }, Dependencies],
    },
    { logger: false },
  );
  configureHttp(app, config, false);
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()) + '/webhooks/whatsapp';
  const challenge = `?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=123456`;
  const id = `wamid.http.${randomUUID()}`;
  const value = {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: scope.phone },
    messages: [
      {
        id,
        from: '351900000096',
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: 'HTTP Unicode 👋' },
      },
    ],
  };
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: scope.account, changes: [{ field: 'messages', value }] }],
  };
  const raw = JSON.stringify(payload, null, 2);
  const signature = (body: string) =>
    `sha256=${createHmac('sha256', scope.secret).update(body).digest('hex')}`;
  const send = (
    body: string,
    sig = signature(body),
    type = 'application/json',
    encoding?: string,
  ) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': type,
        'X-Hub-Signature-256': sig,
        ...(encoding ? { 'Content-Encoding': encoding } : {}),
      },
      body,
    });
  try {
    assert.equal((await fetch(url + challenge)).status, 404);
    assert.equal((await send(raw)).status, 404);
    config.WHATSAPP_WEBHOOK_ENABLED = 'true';
    const verified = await fetch(url + challenge);
    assert.equal(verified.status, 200);
    assert.equal(await verified.text(), '123456');
    assert.equal((await fetch(url + challenge.replace(token, 'wrong'))).status, 403);
    assert.equal((await fetch(url + challenge + '&hub.verify_token=other')).status, 403);
    assert.equal((await send(raw, 'bad')).status, 403);
    assert.equal((await send(JSON.stringify(payload), signature(raw))).status, 403);
    assert.equal((await send('{bad json')).status, 400);
    assert.equal((await send(raw, signature(raw), 'text/plain')).status, 415);
    assert.equal((await send(raw, signature(raw), 'application/json', 'gzip')).status, 415);
    assert.equal((await send('x'.repeat(256 * 1024 + 1))).status, 413);
    assert.equal(
      await admin.externalEvent.count({
        where: {
          provider: 'whatsapp',
          externalEventId: `${scope.channelId}:${id}`,
        },
      }),
      0,
    );
    const accepted = await send(raw);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal(await accepted.text(), 'EVENT_RECEIVED');
    // Success only after durable event/outbox commit, not merely queue publication.
    const event = await admin.externalEvent.findUniqueOrThrow({
      where: {
        provider_externalEventId: {
          provider: 'whatsapp',
          externalEventId: `${scope.channelId}:${id}`,
        },
      },
    });
    assert.equal(event.tenantId, scope.tenantId);
    assert(
      await admin.inboundOutbox.findUnique({
        where: {
          tenantId_id: { tenantId: scope.tenantId, id: event.id },
        },
      }),
    );
    assert.equal((await send(raw)).status, 200);
    assert.equal(await admin.externalEvent.count({ where: { id: event.id } }), 1);
    const unsupported = raw.replace('"type": "text"', '"type": "image"');
    assert.equal((await send(unsupported)).status, 503);
    config.WHATSAPP_QUARANTINE_KEY_ID = 'http-test-v1';
    config.WHATSAPP_QUARANTINE_KEY = randomBytes(32).toString('base64');
    assert.equal((await send(unsupported)).status, 200);
    assert.equal((await send(unsupported)).status, 200);
    assert.equal(
      await admin.whatsAppQuarantine.count({
        where: {
          tenantId: scope.tenantId,
          keyId: 'http-test-v1',
          channelId: scope.channelId,
        },
      }),
      1,
    );
    const unknown = JSON.stringify({
      ...payload,
      entry: [{ ...payload.entry[0]!, id: '999999999999999999' }],
    });
    const unavailable = await send(unknown);
    assert.equal(unavailable.status, 503);
    assert(!(await unavailable.text()).includes(scope.secret));
    config.WHATSAPP_WEBHOOK_RATE_LIMIT = 1;
    assert.equal((await send(raw)).status, 429);
    config.WHATSAPP_WEBHOOK_RATE_LIMIT = 300;
    app.get(Dependencies).redis.disconnect();
    assert.equal((await send(raw)).status, 503);
  } finally {
    await app.close();
  }
}
