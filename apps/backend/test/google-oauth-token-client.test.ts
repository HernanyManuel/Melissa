import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GoogleOAuthInvalidGrant,
  GoogleOAuthTokenClient,
  GoogleOAuthUnavailable,
} from '../src/calendar/google-oauth-token-client';
import { SecretResolver } from '../src/secrets/secret-resolver';

class MemorySecrets implements SecretResolver {
  readonly references: string[] = [];

  constructor(private readonly value = 'synthetic-google-client-secret') {}

  async resolve(reference: string): Promise<string> {
    this.references.push(reference);
    return this.value;
  }
}

const verifier = 'a'.repeat(43);
const redirectUri = 'https://app.example.test/calendar/google/callback';
const secretReference = 'secret://config/google-client-secret';

test('Google OAuth exchanges an authorization code with server-owned secret and PKCE', async () => {
  const secrets = new MemorySecrets();
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const now = new Date('2030-01-01T00:00:00Z');
  const client = new GoogleOAuthTokenClient(
    secrets,
    'google-client-id',
    secretReference,
    1000,
    async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(
        JSON.stringify({
          access_token: 'synthetic-google-access-token',
          refresh_token: 'synthetic-google-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events openid',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    () => now,
  );

  const result = await client.exchange({
    code: 'synthetic-authorization-code',
    redirectUri,
    pkceVerifier: verifier,
  });

  assert.equal(seenUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.redirect, 'error');
  assert.equal((seenInit?.headers as Record<string, string>).accept, 'application/json');
  const body = new URLSearchParams(String(seenInit?.body));
  assert.equal(body.get('client_id'), 'google-client-id');
  assert.equal(body.get('client_secret'), 'synthetic-google-client-secret');
  assert.equal(body.get('code'), 'synthetic-authorization-code');
  assert.equal(body.get('code_verifier'), verifier);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('redirect_uri'), redirectUri);
  assert.deepEqual(secrets.references, [secretReference]);
  assert.deepEqual(result, {
    accessToken: 'synthetic-google-access-token',
    refreshToken: 'synthetic-google-refresh-token',
    accessTokenExpiresAt: new Date('2030-01-01T01:00:00Z'),
    scopes: ['https://www.googleapis.com/auth/calendar.events', 'openid'],
  });
});

test('Google OAuth maps invalid_grant separately without exposing provider details', async () => {
  const client = new GoogleOAuthTokenClient(
    new MemorySecrets(),
    'google-client-id',
    secretReference,
    1000,
    async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive detail' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  );

  await assert.rejects(
    () =>
      client.exchange({
        code: 'expired-authorization-code',
        redirectUri,
        pkceVerifier: verifier,
      }),
    (error: unknown) =>
      error instanceof GoogleOAuthInvalidGrant && !error.message.includes('sensitive detail'),
  );
});

test('Google OAuth fails closed before or after transport on invalid security boundaries', async () => {
  let calls = 0;
  const invalidPkce = new GoogleOAuthTokenClient(
    new MemorySecrets(),
    'google-client-id',
    secretReference,
    1000,
    async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
  );
  await assert.rejects(
    () =>
      invalidPkce.exchange({
        code: 'synthetic-authorization-code',
        redirectUri,
        pkceVerifier: 'short',
      }),
    GoogleOAuthUnavailable,
  );
  assert.equal(calls, 0);

  const missingSecret = new GoogleOAuthTokenClient(
    { resolve: async () => Promise.reject(new Error('secret backend detail')) },
    'google-client-id',
    secretReference,
    1000,
    async () => {
      assert.fail('transport should not be reached');
    },
  );
  await assert.rejects(
    () =>
      missingSecret.exchange({
        code: 'synthetic-authorization-code',
        redirectUri,
        pkceVerifier: verifier,
      }),
    GoogleOAuthUnavailable,
  );

  const malformed = new GoogleOAuthTokenClient(
    new MemorySecrets(),
    'google-client-id',
    secretReference,
    1000,
    async () =>
      new Response(
        JSON.stringify({ access_token: 'too-short', expires_in: 3600, token_type: 'Bearer' }),
      ),
  );
  await assert.rejects(
    () =>
      malformed.exchange({
        code: 'synthetic-authorization-code',
        redirectUri,
        pkceVerifier: verifier,
      }),
    GoogleOAuthUnavailable,
  );

  const oversized = new GoogleOAuthTokenClient(
    new MemorySecrets(),
    'google-client-id',
    secretReference,
    1000,
    async () => new Response('{}', { status: 200, headers: { 'content-length': '65537' } }),
  );
  await assert.rejects(
    () =>
      oversized.exchange({
        code: 'synthetic-authorization-code',
        redirectUri,
        pkceVerifier: verifier,
      }),
    GoogleOAuthUnavailable,
  );
});
