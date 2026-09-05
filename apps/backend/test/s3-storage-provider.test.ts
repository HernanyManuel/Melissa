import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/config';
import { S3StorageProvider } from '../src/storage/s3-storage-provider';
import { createStorageProvider } from '../src/storage/storage-factory';
import { StoragePayloadConflict } from '../src/storage/storage-provider';

const base = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};
const fixed = new Date('2026-09-05T12:00:00.000Z');

function subject() {
  let stored: { body: Uint8Array; type: string; checksum: string } | undefined;
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const headers = new Headers(init.headers);
    assert.match(headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=test-access/);
    assert.equal(headers.get('authorization')?.includes('test-secret'), false);
    assert.equal(headers.get('x-amz-date'), '20260905T120000Z');
    if (init.method === 'PUT') {
      if (stored) return new Response(null, { status: 412 });
      assert.equal(headers.get('if-none-match'), '*');
      stored = {
        body: Uint8Array.from(init.body as Uint8Array),
        type: headers.get('content-type')!,
        checksum: headers.get('x-amz-meta-melissa-checksum')!,
      };
      return new Response(null, { status: 200 });
    }
    if (!stored) return new Response(null, { status: 404 });
    const metadata = {
      'content-type': stored.type,
      'content-length': String(stored.body.byteLength),
      'x-amz-meta-melissa-checksum': stored.checksum,
      'last-modified': fixed.toUTCString(),
    };
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: metadata });
    if (init.method === 'GET')
      return new Response(Buffer.from(stored.body), { status: 200, headers: metadata });
    if (init.method === 'DELETE') {
      stored = undefined;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  };
  return {
    requests,
    provider: new S3StorageProvider(
      'https://objects.example.test',
      'eu-west-1',
      'melissa-private',
      {
        accessKeyId: 'test-access',
        secretAccessKey: 'test-secret-never-real',
        sessionToken: 'test-session-token',
      },
      10,
      1000,
      fetcher,
      () => fixed,
    ),
  };
}

test('S3 storage signs private conditional writes and verifies reads idempotently', async () => {
  const { provider, requests } = subject();
  const body = Uint8Array.from([1, 2, 3]);
  const first = await provider.put({
    key: 'tenants/t1/media/object_1',
    contentType: 'image/png',
    body,
  });
  const replay = await provider.put({ key: first.key, contentType: first.contentType, body });
  assert.equal(replay.checksumSha256, first.checksumSha256);
  assert.deepEqual((await provider.get(first.key))?.body, body);
  assert.equal(
    requests.every((request) => request.url.startsWith('https://objects.example.test/')),
    true,
  );
  assert.equal(
    requests.every(
      (request) =>
        new Headers(request.init.headers).get('x-amz-security-token') === 'test-session-token',
    ),
    true,
  );
  await assert.rejects(
    provider.put({ key: first.key, contentType: first.contentType, body: Uint8Array.from([9]) }),
    StoragePayloadConflict,
  );
  assert.equal(await provider.delete(first.key), true);
  assert.equal(await provider.delete(first.key), false);
});

test('S3 storage is disabled by default and rejects incomplete or unsafe configuration', () => {
  assert.equal(createStorageProvider(parseConfig(base)), null);
  assert.equal(
    createStorageProvider(
      parseConfig({
        ...base,
        STORAGE_PROVIDER: 'disabled',
        S3_ENDPOINT: '',
        S3_REGION: '',
        S3_BUCKET: '',
        S3_ACCESS_KEY_ID: '',
        S3_SECRET_ACCESS_KEY: '',
        S3_SESSION_TOKEN: '',
      }),
    ),
    null,
  );
  const enabled = {
    ...base,
    STORAGE_PROVIDER: 's3',
    S3_ENDPOINT: 'https://objects.example.test',
    S3_REGION: 'eu-west-1',
    S3_BUCKET: 'melissa-private',
    S3_ACCESS_KEY_ID: 'test-access',
    S3_SECRET_ACCESS_KEY: 'test-secret-never-real',
  };
  assert.equal(createStorageProvider(parseConfig(enabled))?.providerKey, 's3');
  assert.throws(
    () => parseConfig({ ...enabled, MEDIA_INGESTION_WORKER_ENABLED: 'true' }),
    /requires transport, storage and quarantine keyring/,
  );
  assert.equal(
    parseConfig({
      ...enabled,
      MEDIA_INGESTION_WORKER_ENABLED: 'true',
      WHATSAPP_MEDIA_ENABLED: 'true',
      WHATSAPP_MEDIA_ACCESS_TOKEN: 'synthetic-test-token-never-real',
      WHATSAPP_MEDIA_API_VERSION: 'v23.0',
      WHATSAPP_MEDIA_DOWNLOAD_HOSTS: 'media.example.test',
      WHATSAPP_QUARANTINE_KEY_ID: 'current',
      WHATSAPP_QUARANTINE_KEY: Buffer.alloc(32, 7).toString('base64'),
    }).MEDIA_INGESTION_WORKER_ENABLED,
    'true',
  );
  for (const endpoint of [
    'http://objects.example.test',
    'https://user:pass@objects.example.test',
    'https://objects.example.test/prefix',
    'https://objects.example.test:9443',
  ])
    assert.throws(() => parseConfig({ ...enabled, S3_ENDPOINT: endpoint }), /secure and complete/);
  assert.throws(() => parseConfig({ ...base, S3_REGION: 'eu-west-1' }), /STORAGE_PROVIDER=s3/);
  assert.throws(() => parseConfig({ ...enabled, S3_BUCKET: undefined }), /secure and complete/);
});

test('S3 storage rejects unsafe keys, types, empty bodies and invalid metadata', async () => {
  const { provider } = subject();
  for (const key of ['../secret', '/absolute', 'a//b'])
    await assert.rejects(provider.put({ key, contentType: 'image/png', body: Uint8Array.of(1) }));
  await assert.rejects(
    provider.put({ key: 'safe/key', contentType: 'text/html;evil', body: Uint8Array.of(1) }),
  );
  await assert.rejects(
    provider.put({ key: 'safe/key', contentType: 'image/png', body: new Uint8Array() }),
  );
});
