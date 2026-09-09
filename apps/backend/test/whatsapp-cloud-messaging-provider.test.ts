import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MessagingDeliveryUnknown,
  MessagingProviderUnavailable,
} from '../src/channels/messaging-provider';
import { WhatsAppCloudMessagingProvider } from '../src/channels/whatsapp-cloud-messaging-provider';
import { SecretResolver } from '../src/secrets/secret-resolver';

class MemorySecrets implements SecretResolver {
  references: string[] = [];

  async resolve(reference: string): Promise<string> {
    this.references.push(reference);
    return 'synthetic-server-access-token';
  }
}

const input = {
  attemptId: '00000000-0000-4000-8000-000000000001',
  recipientReference: '+351910000000',
  senderReference: '123456789012345',
  credentialsReference: 'secret://tenant/channel/whatsapp',
  text: 'Olá',
};

test('WhatsApp live transport resolves secret reference and sends fixed Graph request', async () => {
  const secrets = new MemorySecrets();
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetcher = async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenInit = init;
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = new WhatsAppCloudMessagingProvider(secrets, 'v23.0', 1000, fetcher);
  const delivery = await provider.sendText(input);
  assert.deepEqual(secrets.references, [input.credentialsReference]);
  assert.equal(
    seenUrl,
    'https://graph.facebook.com/v23.0/123456789012345/messages',
  );
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.redirect, 'error');
  assert.equal(
    (seenInit?.headers as Record<string, string>).authorization,
    'Bearer synthetic-server-access-token',
  );
  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: input.recipientReference,
    type: 'text',
    text: { body: input.text, preview_url: false },
  });
  assert.equal(delivery.providerMessageId, 'wamid.test');
  assert(delivery.acceptedAt instanceof Date);
});

test('WhatsApp live transport rejects incomplete routing before network', async () => {
  const secrets = new MemorySecrets();
  let calls = 0;
  const provider = new WhatsAppCloudMessagingProvider(
    secrets,
    'v23.0',
    1000,
    async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
  );
  await assert.rejects(
    () => provider.sendText({ ...input, senderReference: '' }),
    MessagingProviderUnavailable,
  );
  assert.equal(calls, 0);
  assert.equal(secrets.references.length, 0);
});

test('WhatsApp live transport treats provider failure as ambiguous delivery', async () => {
  const provider = new WhatsAppCloudMessagingProvider(
    new MemorySecrets(),
    'v23.0',
    1000,
    async () => new Response('{}', { status: 503 }),
  );
  await assert.rejects(() => provider.sendText(input), MessagingDeliveryUnknown);
});

test('WhatsApp live transport treats malformed success receipt as ambiguous delivery', async () => {
  const provider = new WhatsAppCloudMessagingProvider(
    new MemorySecrets(),
    'v23.0',
    1000,
    async () => new Response(JSON.stringify({ messages: [{}] }), { status: 200 }),
  );
  await assert.rejects(() => provider.sendText(input), MessagingDeliveryUnknown);
});
