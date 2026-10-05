import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WhatsAppCloudMessagingProvider } from '../src/channels/whatsapp-cloud-messaging-provider';
import { MountedFileSecretResolver } from '../src/secrets/mounted-file-secret-resolver';

const input = {
  attemptId: '00000000-0000-4000-8000-000000000001',
  recipientReference: '+351910000000',
  senderReference: '123456789012345',
  credentialsReference: 'secret://whatsapp',
  text: 'Olá',
};

test('WhatsApp live transport observes mounted credential rotation without restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melissa-whatsapp-secret-rotation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, 'whatsapp');
  await writeFile(current, 'synthetic-token-v1');
  const secrets = await MountedFileSecretResolver.create(root);
  const authorizations: string[] = [];
  const provider = new WhatsAppCloudMessagingProvider(
    secrets,
    'v23.0',
    1000,
    async (_url, init) => {
      authorizations.push((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.rotation' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );

  await provider.sendText(input);
  const replacement = join(root, 'replacement');
  await writeFile(replacement, 'synthetic-token-v2');
  await rename(replacement, current);
  await provider.sendText(input);

  assert.deepEqual(authorizations, ['Bearer synthetic-token-v1', 'Bearer synthetic-token-v2']);
});
