import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { queueConnection } from '../src/queue-connection';
import { WhatsAppIngress } from '../src/channels/whatsapp-ingress';
import { PrismaClient } from '@prisma/client';
import { WhatsAppRouting } from '../src/channels/whatsapp-routing';

// Called only by the disposable integration suite. Migration credentials are never used by runtime.
export async function testWhatsAppRouting(db: PrismaClient, tenantA: string, tenantB: string) {
  const url = process.env.MIGRATION_DATABASE_URL;
  assert(url, 'Routing fixture requires explicit MIGRATION_DATABASE_URL');
  const admin = new PrismaClient({ datasources: { db: { url } } });
  const integration = `test_${randomUUID()}`;
  const account = String(Date.now());
  const phone = account + '1';
  const channelId = randomUUID();
  const routing = new WhatsAppRouting(db, integration);
  const refuse = () => assert.fail('Unauthorized routing callback');
  try {
    await admin.channelConnection.create({
      data: {
        tenantId: tenantA,
        id: channelId,
        channelType: 'whatsapp',
        mode: 'live',
        externalAccountId: account,
        externalPhoneId: phone,
        displayName: 'Synthetic routing fixture',
        credentialsReference: 'test-only',
        webhookSecretReference: 'test-only',
      },
    });
    await admin.$executeRaw`INSERT INTO whatsapp_routes(integration_key,account_id,phone_id,tenant_id,channel_id)
      VALUES(${integration},${account},${phone},${tenantA}::uuid,${channelId}::uuid)`;
    await assert.rejects(admin.$executeRaw`INSERT INTO whatsapp_routes(integration_key,account_id,phone_id,tenant_id,channel_id)
      VALUES(${integration},${account},${phone + '2'},${tenantB}::uuid,${channelId}::uuid)`);
    await assert.rejects(
      db.$executeRaw`DELETE FROM whatsapp_routes WHERE integration_key=${integration}`,
    );
    await assert.rejects(
      db.$executeRaw`UPDATE whatsapp_routes SET tenant_id=${tenantB}::uuid WHERE integration_key=${integration}`,
    );
    await assert.rejects(db.$executeRaw`INSERT INTO whatsapp_routes(integration_key,account_id,phone_id,tenant_id,channel_id)
      VALUES(${integration},${account},${phone + '3'},${tenantA}::uuid,${channelId}::uuid)`);
    await routing.scoped(account, phone, async (tx, route) => {
      assert.deepEqual(route, { tenantId: tenantA, channelId });
      assert.equal(await tx.channelConnection.count({ where: { tenantId: tenantB } }), 0);
      assert.equal(await tx.channelConnection.count({ where: { id: channelId } }), 1);
    });
    assert.equal(
      await db.channelConnection.count({ where: { id: channelId } }),
      0,
      'Context must not leak',
    );
    await assert.rejects(new WhatsAppRouting(db, 'wrong_app').scoped(account, phone, refuse));
    await assert.rejects(routing.scoped(account + '9', phone, refuse));
    await assert.rejects(routing.scoped(account, phone + '9', refuse));
    await assert.rejects(routing.scoped("' OR true--", phone, refuse));
    const customer = await admin.customer.create({
      data: {
        tenantId: tenantA,
        displayName: 'External test',
        phoneE164: '+351900000091',
      },
    });
    const secret = 'synthetic-ingress-test-secret';
    const ingress = new WhatsAppIngress(db, integration, secret, 'test-verify');
    const eventId = `wamid.${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const makeBody = (id = eventId, body = 'Olá externo', sender = '351900000091', type = 'text') =>
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
                    metadata: { phone_number_id: phone },
                    messages: [{ id, from: sender, timestamp, type, text: { body } }],
                  },
                },
              ],
            },
          ],
        }),
      );
    const sign = (body: Buffer) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const body = makeBody();
    await assert.rejects(ingress.receive(body, 'invalid'), /signature/);
    const unknown = makeBody(randomUUID(), 'unknown', '351900000092');
    await assert.rejects(ingress.receive(unknown, sign(unknown)), /customer unavailable/);
    const media = makeBody(randomUUID(), 'media', '351900000091', 'image');
    await assert.rejects(ingress.receive(media, sign(media)), /Unsupported/);
    const queue = new Queue('incoming-messages', {
      connection: queueConnection(process.env.REDIS_URL!),
    });
    let storedId = '';
    let revokedId = '';
    try {
      await queue.pause();
      const [first, duplicate] = await Promise.all([
        ingress.receive(body, sign(body)),
        ingress.receive(body, sign(body)),
      ]);
      storedId = first[0]!.eventId;
      assert.equal(storedId, duplicate[0]!.eventId);
      assert.notEqual(first[0]!.duplicate, duplicate[0]!.duplicate);
      const altered = makeBody(eventId, 'Changed');
      await assert.rejects(ingress.receive(altered, sign(altered)), /payload conflict/);
      const outbox = await admin.inboundOutbox.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: tenantA, id: storedId } },
      });
      assert.equal(outbox.actorId, null);
      assert.equal(outbox.origin, 'whatsapp');
      assert.equal(outbox.customerId, customer.id);
      assert.equal(outbox.integrationKey, integration);
      assert.equal(
        await admin.auditEvent.count({
          where: {
            tenantId: tenantA,
            actorType: 'whatsapp',
            actorId: null,
            action: 'message.external_payload_conflict',
          },
        }),
        1,
      );
      // Runtime cannot disguise a mock message as an anonymous source.
      await assert.rejects(
        admin.$executeRaw`UPDATE inbound_outbox SET origin='mock' WHERE id=${storedId}::uuid`,
      );
    } finally {
      await queue.resume();
      await queue.close();
    }
    const waitState = async (id: string, state: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await admin.inboundDispatch.findUnique({ where: { id } }))?.state === state) return;
        await delay(100);
      }
      assert.fail(`External receipt did not reach ${state}`);
    };
    await waitState(storedId, 'processed');
    const message = await admin.message.findUniqueOrThrow({ where: { externalEventId: storedId } });
    assert.equal(message.contentText, 'Olá externo');
    assert.equal(message.createdAt.getTime(), Number(timestamp) * 1000);
    assert.equal((await ingress.receive(body, sign(body)))[0]!.eventId, storedId);
    assert.equal(await admin.message.count({ where: { externalEventId: storedId } }), 1);
    assert.equal(
      (
        await admin.inboundOutbox.findUniqueOrThrow({
          where: {
            tenantId_id: { tenantId: tenantA, id: storedId },
          },
        })
      ).contentText,
      null,
    );
    const revokeQueue = new Queue('incoming-messages', {
      connection: queueConnection(process.env.REDIS_URL!),
    });
    try {
      await revokeQueue.pause();
      const pending = makeBody(randomUUID());
      revokedId = (await ingress.receive(pending, sign(pending)))[0]!.eventId;
      await admin.$executeRaw`DELETE FROM whatsapp_routes WHERE integration_key=${integration}`;
    } finally {
      await revokeQueue.resume();
      await revokeQueue.close();
    }
    await waitState(revokedId, 'rejected');
    assert.equal(await admin.message.count({ where: { externalEventId: revokedId } }), 0);
    await admin.$executeRaw`INSERT INTO whatsapp_routes(integration_key,account_id,phone_id,tenant_id,channel_id)
      VALUES(${integration},${account},${phone},${tenantA}::uuid,${channelId}::uuid)`;
    await admin.channelConnection.update({
      where: { tenantId_id: { tenantId: tenantA, id: channelId } },
      data: { externalAccountId: account + '8' },
    });
    await assert.rejects(routing.scoped(account, phone, refuse));
    await admin.channelConnection.update({
      where: { tenantId_id: { tenantId: tenantA, id: channelId } },
      data: { externalAccountId: account, status: 'disconnected', disconnectedAt: new Date() },
    });
    await assert.rejects(routing.scoped(account, phone, refuse));
  } finally {
    await admin.$disconnect();
  }
}
