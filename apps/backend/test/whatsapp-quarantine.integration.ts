import assert from 'node:assert/strict';
import { createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { WhatsAppIngress } from '../src/channels/whatsapp-ingress';
import { purgeExpiredQuarantine } from '../src/channels/quarantine-retention';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaIngestor } from '../src/storage/media-ingestor';
import { MediaIngestionProcessor } from '../src/storage/media-ingestion-processor';
import { MockMediaSourceProvider } from '../src/storage/mock-media-source-provider';
import { MockStorageProvider } from '../src/storage/mock-storage-provider';

export async function testWhatsAppQuarantine(
  admin: PrismaClient,
  runtime: PrismaClient,
  scope: {
    integration: string;
    account: string;
    phone: string;
    secret: string;
    tenantId: string;
    otherTenantId: string;
    channelId: string;
  },
) {
  const key = { id: 'test-key-v1', key: randomBytes(32) };
  const ingress = new WhatsAppIngress(
    runtime,
    scope.integration,
    scope.secret,
    'synthetic-verify',
    1500,
    key,
  );
  const messageId = `wamid.media.${randomUUID()}`;
  const message = {
    id: messageId,
    from: '351900000098',
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'image',
    image: { id: 'synthetic-media-id', mime_type: 'image/jpeg', caption: 'Private caption' },
  };
  const body = (payload: object, account = scope.account) =>
    Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: account,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: scope.phone },
                  messages: [payload],
                },
              },
            ],
          },
        ],
      }),
    );
  const send = (raw: Buffer) =>
    ingress.receive(raw, `sha256=${createHmac('sha256', scope.secret).update(raw).digest('hex')}`);
  const before = await admin.customer.count({ where: { tenantId: scope.tenantId } });
  const raw = body(message);
  await assert.rejects(ingress.receive(raw, 'invalid'), /signature/);
  await assert.rejects(send(body(message, '99999999999999999')), /route unavailable/);
  const [one, two] = await Promise.all([send(raw), send(raw)]);
  assert.equal(one[0]!.eventId, two[0]!.eventId);
  assert.notEqual(one[0]!.duplicate, two[0]!.duplicate);
  const row = await admin.whatsAppQuarantine.findUniqueOrThrow({
    where: {
      tenantId_id: { tenantId: scope.tenantId, id: one[0]!.eventId },
    },
  });
  assert.equal(row.channelId, scope.channelId);
  assert.equal(row.keyId, key.id);
  assert(!Buffer.from(row.ciphertext).includes(Buffer.from('Private caption')));
  const decrypt = (tenantId: string) => {
    const decipher = createDecipheriv('aes-256-gcm', key.key, row.nonce);
    decipher.setAAD(Buffer.from(JSON.stringify([tenantId, scope.channelId, row.id, key.id])));
    decipher.setAuthTag(Buffer.from(row.tag));
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  };
  assert.deepEqual(JSON.parse(decrypt(scope.tenantId)), message);
  const mediaEnvelope = await admin.mediaIngestionDispatch.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: scope.tenantId, id: row.id } },
  });
  assert.deepEqual(Object.keys(mediaEnvelope).sort(), [
    'attempts',
    'checksumSha256',
    'contentType',
    'createdAt',
    'id',
    'nextAttemptAt',
    'sizeBytes',
    'state',
    'storageKey',
    'tenantId',
  ]);
  assert.equal(mediaEnvelope.state, 'quarantined');
  const storage = new MockStorageProvider();
  const processor = new MediaIngestionProcessor(
    runtime,
    new MediaIngestor(
      new MockMediaSourceProvider({
        'synthetic-media-id': {
          contentType: 'image/jpeg',
          body: Uint8Array.from([1, 2, 3]),
        },
      }),
      storage,
    ),
    (keyId) => (keyId === key.id ? key.key : null),
  );
  await Promise.all([processor.process(row.id, 0), processor.process(row.id, 0)]);
  const storedMedia = await admin.mediaIngestionDispatch.findUniqueOrThrow({
    where: { id: row.id },
  });
  assert.equal(storedMedia.state, 'stored');
  assert.equal(storedMedia.contentType, 'image/jpeg');
  assert.equal(storedMedia.sizeBytes, 3);
  assert(storedMedia.storageKey);
  assert.deepEqual((await storage.get(storedMedia.storageKey))?.body, Uint8Array.from([1, 2, 3]));
  assert.equal(
    await admin.auditEvent.count({
      where: { tenantId: scope.tenantId, targetId: row.id, action: 'media.ingestion_stored' },
    }),
    1,
  );
  assert.throws(() => decrypt(scope.otherTenantId));
  // Object key order is not a semantic payload change.
  assert.equal(
    (
      await send(
        body({
          ...message,
          image: {
            caption: 'Private caption',
            mime_type: 'image/jpeg',
            id: 'synthetic-media-id',
          },
        }),
      )
    )[0]!.eventId,
    row.id,
  );
  await assert.rejects(
    send(body({ ...message, image: { ...message.image, caption: 'Changed' } })),
    /conflict/,
  );
  assert.equal(await admin.customer.count({ where: { tenantId: scope.tenantId } }), before);
  assert.equal(await admin.inboundDispatch.count({ where: { id: row.id } }), 0);
  assert.equal(await runtime.whatsAppQuarantine.count(), 0);
  await runtime.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id',${scope.otherTenantId},true)`;
    assert.equal(await tx.whatsAppQuarantine.count({ where: { id: row.id } }), 0);
  });
  // Discovery is global but minimal; lifecycle mutation requires an explicit tenant context.
  assert(await runtime.mediaIngestionDispatch.findUnique({ where: { id: row.id } }));
  await assert.rejects(
    runtime.mediaIngestionDispatch.update({
      where: { id: row.id },
      data: { state: 'quarantined' },
    }),
  );
  await assert.rejects(runtime.mediaIngestionDispatch.delete({ where: { id: row.id } }));
  await runtime.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id',${scope.tenantId},true)`;
    assert.equal((await tx.whatsAppQuarantine.deleteMany({ where: { id: row.id } })).count, 0);
  });
  assert.equal(
    await admin.auditEvent.count({
      where: {
        tenantId: scope.tenantId,
        action: 'message.whatsapp_quarantined',
        targetId: row.id,
      },
    }),
    1,
  );
  const keyWhere = { tenantId_id: { tenantId: scope.tenantId, id: row.id } };
  const envelope = await runtime.quarantineExpiry.findUniqueOrThrow({ where: keyWhere });
  assert.equal(envelope.expiresAt.getTime(), row.expiresAt.getTime());
  await assert.rejects(
    runtime.quarantineExpiry.update({ where: keyWhere, data: { expiresAt: new Date(0) } }),
  );
  const future = await admin.whatsAppQuarantine.findFirstOrThrow({
    where: {
      tenantId: scope.tenantId,
      id: { not: row.id },
      expiresAt: { gt: new Date() },
    },
  });
  // FK carries the administrative fixture expiry change to its envelope automatically.
  await admin.whatsAppQuarantine.update({
    where: keyWhere,
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await admin.$executeRaw`DELETE FROM whatsapp_routes WHERE integration_key=${scope.integration}`;
  try {
    // Do not call purge here: prove the separate worker's scheduler handles a revoked binding.
    for (let i = 0; i < 150; i++) {
      if (!(await admin.whatsAppQuarantine.findUnique({ where: keyWhere }))) break;
      await delay(100);
    }
    assert.equal(await admin.whatsAppQuarantine.findUnique({ where: keyWhere }), null);
    assert.equal(await runtime.quarantineExpiry.findUnique({ where: keyWhere }), null);
    assert.equal(await admin.mediaIngestionDispatch.findUnique({ where: keyWhere }), null);
    assert(
      await admin.whatsAppQuarantine.findUnique({
        where: {
          tenantId_id: { tenantId: scope.tenantId, id: future.id },
        },
      }),
    );
    assert(await admin.externalEvent.findUnique({ where: keyWhere }));
    assert.equal(
      await admin.auditEvent.count({
        where: {
          tenantId: scope.tenantId,
          targetId: row.id,
          action: 'message.quarantine_purged',
        },
      }),
      1,
    );
  } finally {
    await admin.$executeRaw`INSERT INTO whatsapp_routes(integration_key,account_id,phone_id,tenant_id,channel_id)
      VALUES(${scope.integration},${scope.account},${scope.phone},${scope.tenantId}::uuid,${scope.channelId}::uuid)`;
  }
  // Old duplicate must not restore expired content.
  assert.equal((await send(raw))[0]!.eventId, row.id);
  assert.equal(await admin.whatsAppQuarantine.findUnique({ where: keyWhere }), null);
  const concurrent = (await send(body({ ...message, id: `wamid.${randomUUID()}` })))[0]!;
  const concurrentWhere = { tenantId_id: { tenantId: scope.tenantId, id: concurrent.eventId } };
  const unavailable = new MediaIngestionProcessor(
    runtime,
    new MediaIngestor(new MockMediaSourceProvider({}), new MockStorageProvider()),
    () => null,
  );
  await assert.rejects(unavailable.process(concurrent.eventId, 0), /Media ingestion failed/);
  const retry = await admin.mediaIngestionDispatch.findUniqueOrThrow({
    where: { id: concurrent.eventId },
  });
  assert.equal(retry.state, 'quarantined');
  assert.equal(retry.attempts, 1);
  assert(retry.nextAttemptAt > new Date());
  await unavailable.process(concurrent.eventId, 0); // stale attempt is ignored
  assert.equal(
    await admin.auditEvent.count({
      where: {
        tenantId: scope.tenantId,
        targetId: concurrent.eventId,
        action: 'media.ingestion_retry',
      },
    }),
    1,
  );
  await admin.whatsAppQuarantine.update({
    where: concurrentWhere,
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await Promise.all([purgeExpiredQuarantine(runtime), purgeExpiredQuarantine(runtime)]);
  assert.equal(await admin.whatsAppQuarantine.findUnique({ where: concurrentWhere }), null);
  assert.equal(
    await admin.auditEvent.count({
      where: {
        tenantId: scope.tenantId,
        targetId: concurrent.eventId,
        action: 'message.quarantine_purged',
      },
    }),
    1,
  );
}
