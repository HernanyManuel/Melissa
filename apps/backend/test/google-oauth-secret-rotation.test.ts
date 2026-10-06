import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GoogleOAuthTokenClient } from '../src/calendar/google-oauth-token-client';
import { MountedFileSecretResolver } from '../src/secrets/mounted-file-secret-resolver';

const verifier = 'a'.repeat(43);
const redirectUri = 'https://app.example.test/calendar/google/callback';

test('Google OAuth observes mounted client secret rotation without restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melissa-google-secret-rotation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, 'google-client-secret');
  await writeFile(current, 'synthetic-google-secret-v1');
  const secrets = await MountedFileSecretResolver.create(root);
  const clientSecrets: string[] = [];
  const client = new GoogleOAuthTokenClient(
    secrets,
    'google-client-id',
    'secret://google-client-secret',
    1000,
    async (_url, init) => {
      const body = new URLSearchParams(String(init.body));
      const clientSecret = body.get('client_secret');
      assert(clientSecret);
      clientSecrets.push(clientSecret);
      return new Response(
        JSON.stringify({
          access_token: 'synthetic-google-access-token',
          refresh_token: 'synthetic-google-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  await client.exchange({
    code: 'synthetic-authorization-code',
    redirectUri,
    pkceVerifier: verifier,
  });
  const replacement = join(root, 'replacement');
  await writeFile(replacement, 'synthetic-google-secret-v2');
  await rename(replacement, current);
  await client.exchange({
    code: 'synthetic-authorization-code',
    redirectUri,
    pkceVerifier: verifier,
  });

  assert.deepEqual(clientSecrets, ['synthetic-google-secret-v1', 'synthetic-google-secret-v2']);
});
