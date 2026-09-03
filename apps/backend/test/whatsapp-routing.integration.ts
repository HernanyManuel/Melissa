import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
