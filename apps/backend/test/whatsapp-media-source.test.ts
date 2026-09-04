import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaUnavailable } from '../src/storage/media-source-provider';
import { WhatsAppGraphMediaSource } from '../src/storage/whatsapp-graph-media-source';

const token = 'synthetic-test-token-never-real';
const bytes = Uint8Array.from([1, 2, 3]);
const metadata = {
  url: 'https://media.example.test/object',
  mime_type: 'image/png',
  file_size: 3,
  sha256: '0'.repeat(64),
};

test('WhatsApp media source uses bearer auth, fixed graph origin and bounded download', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const source = new WhatsAppGraphMediaSource(
    token,
    'v23.0',
    ['media.example.test'],
    4,
    1000,
    async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(JSON.stringify(metadata), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response(bytes, {
            headers: { 'content-type': 'image/png', 'content-length': '3' },
          });
    },
  );
  const result = await source.download('media_123');
  assert.deepEqual(result, {
    contentType: 'image/png',
    body: bytes,
    checksumSha256: metadata.sha256,
  });
  assert.equal(calls[0]?.url, 'https://graph.facebook.com/v23.0/media_123');
  assert.equal(calls[1]?.url, metadata.url);
  for (const call of calls) {
    assert.deepEqual(call.init.headers, {
      accept: call === calls[0] ? 'application/json' : 'image/png',
      authorization: `Bearer ${token}`,
    });
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.url.includes(token), false);
  }
});

test('WhatsApp media source blocks unapproved hosts and oversized metadata before download', async () => {
  for (const changed of [
    { ...metadata, url: 'https://evil.example/object' },
    { ...metadata, url: 'http://media.example.test/object' },
    { ...metadata, url: 'https://user:pass@media.example.test/object' },
    { ...metadata, url: 'https://media.example.test:444/object' },
    { ...metadata, url: 'https://media.example.test/object#fragment' },
    { ...metadata, file_size: 5 },
  ]) {
    let calls = 0;
    const source = new WhatsAppGraphMediaSource(
      token,
      'v23.0',
      ['media.example.test'],
      4,
      1000,
      async () => {
        calls++;
        return new Response(JSON.stringify(changed));
      },
    );
    await assert.rejects(source.download('media_123'), MediaUnavailable);
    assert.equal(calls, 1);
  }
});

test('WhatsApp media source rejects redirects, type/size mismatch and sanitized failures', async () => {
  for (const second of [
    new Response(null, { status: 302, headers: { location: 'https://evil.example/object' } }),
    new Response(bytes, { headers: { 'content-type': 'text/html' } }),
    new Response(Uint8Array.from([1, 2]), { headers: { 'content-type': 'image/png' } }),
    new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
      headers: { 'content-type': 'image/png' },
    }),
  ]) {
    let calls = 0;
    const source = new WhatsAppGraphMediaSource(
      token,
      'v23.0',
      ['media.example.test'],
      4,
      1000,
      async () => (++calls === 1 ? new Response(JSON.stringify(metadata)) : second),
    );
    await assert.rejects(source.download('media_123'), (error) => {
      assert(error instanceof MediaUnavailable);
      assert.equal(error.message.includes('evil.example'), false);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});

test('WhatsApp media source configuration and IDs fail closed', async () => {
  assert.throws(() => new WhatsAppGraphMediaSource(token, 'latest', ['media.example.test']));
  assert.throws(() => new WhatsAppGraphMediaSource(token, 'v23.0', []));
  assert.throws(() => new WhatsAppGraphMediaSource(token, 'v23.0', ['localhost']));
  const source = new WhatsAppGraphMediaSource(token, 'v23.0', ['media.example.test']);
  await assert.rejects(source.download('../object'), /Invalid media ID/);
});
