import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration, parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { configureHttp } from '../src/http';
import { verifyStripeSignature } from '../src/billing/stripe-signature';
import { waitReady } from './wait-ready';

const secret = 'whsec_strictly_test_only_secret_123456789';
// prettier-ignore
const signed = (body: Buffer, t: number, key = secret) =>
  `t=${t},v1=${createHmac('sha256', key).update(Buffer.concat([
    Buffer.from(`${t}.`), body,
  ])).digest('hex')}`;

// prettier-ignore
test('Stripe signed test webhook persists immutable idempotent events without activating billing', { timeout: 30000 }, async () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  assert(migrationUrl, 'Stripe webhook integration requires MIGRATION_DATABASE_URL');
  assert.equal(parseConfig({
    DATABASE_URL: 'postgresql://localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
  }).STRIPE_WEBHOOK_ENABLED, 'false');
  assert.throws(() => parseConfig({
    DATABASE_URL: 'postgresql://localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    STRIPE_WEBHOOK_ENABLED: 'true',
  }), /Stripe webhook requires/);
  assert.equal(verifyStripeSignature(Buffer.from('{}'), undefined, secret), false);

  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  const deps = app.get(Dependencies);
  const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
  // Controlled test-only wiring; nothing in application defaults enables ingress.
  config.STRIPE_WEBHOOK_ENABLED = 'true';
  config.STRIPE_WEBHOOK_SECRET = secret;
  configureHttp(app, config, false);
  await app.listen(0, '127.0.0.1');
  const endpoint = (await app.getUrl()) + '/webhooks/stripe';
  const now = Math.floor(Date.now() / 1000);
  const id = 'evt_' + randomUUID().replace(/-/g, '');
  const event = {
    id,
    object: 'event',
    type: 'customer.subscription.updated',
    created: now - 2,
    livemode: false,
    api_version: '2025-09-30.clover',
    data: { object: { id: 'sub_private_' + randomUUID(), customer: 'cus_secret',
      status: 'active', metadata: { tenant_id: randomUUID() } } },
  };
  const body = Buffer.from(JSON.stringify(event));
  const post = (payload: Buffer, signature?: string, contentType = 'application/json') =>
    fetch(endpoint, { method: 'POST', headers: {
      'Content-Type': contentType,
      ...(signature !== undefined ? { 'Stripe-Signature': signature } : {}),
    }, body: new Uint8Array(payload) });
  const count = () => admin.stripeWebhookEvent.count({ where: { eventId: id } });

  try {
    await waitReady(await app.getUrl());
    const [rls] = await deps.db.$queryRaw<Array<{ relrowsecurity: boolean;
      relforcerowsecurity: boolean }>>`
      SELECT relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE relname='stripe_webhook_events'`;
    assert(rls);
    assert(rls.relrowsecurity);
    assert(rls.relforcerowsecurity);

    assert.equal((await post(body)).status, 403);
    assert.equal((await post(body, signed(body, now, 'whsec_wrong_secret'))).status, 403);
    assert.equal((await post(body, signed(body, now - 301))).status, 403);
    assert.equal((await post(body, signed(body, now + 301))).status, 403);
    assert.equal((await post(body, 't=notanumber,v1=abc')).status, 403);
    assert.equal((await post(body, signed(body, now), 'text/plain')).status, 415);
    assert.equal((await post(Buffer.from('not json'), signed(Buffer.from('not json'), now))).status, 400);
    assert.equal((await post(Buffer.from(JSON.stringify({...event, livemode: true})),
      signed(Buffer.from(JSON.stringify({...event, livemode: true})), now))).status, 400);
    assert.equal(await count(), 0);

    const ignored = {...event, id: 'evt_' + randomUUID().replace(/-/g, ''),
      type: 'some.unused.event'};
    const ignoredBody = Buffer.from(JSON.stringify(ignored));
    assert.equal((await post(ignoredBody, signed(ignoredBody, now))).status, 200);
    assert.equal(await admin.stripeWebhookEvent.count({ where: { eventId: ignored.id } }), 0);

    const first = await post(body, 't=' + now +
      ',v1=' + '0'.repeat(64) + ',v1=' + signed(body, now).split('v1=')[1]);
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await first.json(), { received: true });
    assert.equal(await count(), 1);
    const stored = await admin.stripeWebhookEvent.findUniqueOrThrow({ where: { eventId: id } });
    assert.equal(stored.status, 'received');
    assert.equal(stored.livemode, false);
    assert.equal(stored.eventType, event.type);
    assert.equal(stored.payloadSha256, createHash('sha256').update(body).digest('hex'));
    assert.equal((stored.payload as { data: { object: { metadata: { tenant_id: string } } } })
      .data.object.metadata.tenant_id, event.data.object.metadata.tenant_id);

    assert.equal((await post(body, signed(body, now))).status, 200);
    assert.equal(await count(), 1);
    const conflicting = Buffer.from(JSON.stringify({...event, created: now - 3}));
    assert.equal((await post(conflicting, signed(conflicting, now))).status, 409);
    assert.equal(await count(), 1);
    assert.equal((await admin.stripeWebhookEvent.findUniqueOrThrow({
      where: { eventId: id },
    })).payloadSha256, stored.payloadSha256);

    const [rights] = await deps.db.$queryRaw<Array<{
      canReadPayload: boolean; canReadId: boolean; canUpdate: boolean; canDelete: boolean;
    }>>`SELECT
      has_column_privilege(current_user,'stripe_webhook_events','payload','SELECT')
        AS "canReadPayload",
      has_column_privilege(current_user,'stripe_webhook_events','event_id','SELECT')
        AS "canReadId",
      has_table_privilege(current_user,'stripe_webhook_events','UPDATE') AS "canUpdate",
      has_table_privilege(current_user,'stripe_webhook_events','DELETE') AS "canDelete"`;
    assert.deepEqual(rights, {
      canReadPayload: false, canReadId: true, canUpdate: false, canDelete: false,
    });
    await assert.rejects(deps.db.$queryRaw`SELECT payload FROM stripe_webhook_events LIMIT 1`);
    // Validly signed event metadata cannot authorize any subscription.
    assert.equal(await admin.tenantSubscription.count({
      where: { tenantId: event.data.object.metadata.tenant_id },
    }), 0);
    assert.equal((await fetch((await app.getUrl()) + '/health/ready')).status, 200);
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
