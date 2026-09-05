import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaIngestor } from '../src/storage/media-ingestor';
import { MockMediaSourceProvider } from '../src/storage/mock-media-source-provider';
import { MockStorageProvider } from '../src/storage/mock-storage-provider';
import { MediaDownload, MediaUnavailable } from '../src/storage/media-source-provider';

const tenant = '00000000-0000-4000-8000-000000000001';
const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const checksum = createHash('sha256').update(bytes).digest('hex');

function subject(
  fixture: MediaDownload = { contentType: 'image/png', body: bytes, checksumSha256: checksum },
) {
  const storage = new MockStorageProvider(16, 32);
  return {
    storage,
    ingestor: new MediaIngestor(new MockMediaSourceProvider({ media_1: fixture }), storage, 12),
  };
}

test('media ingestion validates and stores under opaque tenant key idempotently', async () => {
  const { ingestor, storage } = subject();
  const first = await ingestor.ingest(tenant.toUpperCase(), 'media_1', 'image/png');
  const replay = await ingestor.ingest(tenant, 'media_1', 'image/png');
  assert.deepEqual(first, replay);
  assert.match(first.key, new RegExp(`^tenants/${tenant}/media/[a-f0-9]{64}$`));
  assert.equal(first.key.includes('media_1'), false);
  assert.deepEqual((await storage.get(first.key))?.body, bytes);
});

test('media ingestion fails closed on identity, type, size, checksum and absence', async () => {
  for (const [fixture, declared, pattern] of [
    [{ contentType: 'image/jpeg', body: bytes }, 'image/png', /type mismatch/],
    [
      { contentType: 'image/png', body: Uint8Array.from([...bytes, 1, 2, 3, 4]) },
      'image/png',
      /too large/,
    ],
    [
      { contentType: 'image/png', body: bytes, checksumSha256: '0'.repeat(64) },
      'image/png',
      /checksum mismatch/,
    ],
    [{ contentType: 'image/png', body: new Uint8Array() }, 'image/png', /body/],
  ] as const) {
    const { ingestor } = subject(fixture);
    await assert.rejects(ingestor.ingest(tenant, 'media_1', declared), pattern);
  }
  const { ingestor } = subject();
  for (const [tenantId, mediaId, type] of [
    ['invalid', 'media_1', 'image/png'],
    [tenant, '../media', 'image/png'],
    [tenant, 'media_1', 'text/html'],
  ] as const)
    await assert.rejects(ingestor.ingest(tenantId, mediaId, type), /Invalid media request/);
  await assert.rejects(ingestor.ingest(tenant, 'missing', 'image/png'), MediaUnavailable);
});

test('media ingestion rejects spoofed MIME and accepts supported binary signatures', async () => {
  const fixtures = [
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['application/pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ['audio/ogg', [0x4f, 0x67, 0x67, 0x53]],
    ['audio/mpeg', [0x49, 0x44, 0x33]],
    ['audio/mpeg', [0xff, 0xfb]],
    ['video/mp4', [0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]],
  ] as const;
  for (const [type, signature] of fixtures) {
    const body = Uint8Array.from(signature);
    const storage = new MockStorageProvider(32, 64);
    const ingestor = new MediaIngestor(
      new MockMediaSourceProvider({ media_1: { contentType: type, body } }),
      storage,
      32,
    );
    assert.equal((await ingestor.ingest(tenant, 'media_1', type)).contentType, type);
  }
  const spoofed = new MediaIngestor(
    new MockMediaSourceProvider({
      media_1: { contentType: 'image/png', body: Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c]) },
    }),
    new MockStorageProvider(),
  );
  await assert.rejects(spoofed.ingest(tenant, 'media_1', 'image/png'), /signature mismatch/);
});
