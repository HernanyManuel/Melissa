import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaIngestor } from '../src/storage/media-ingestor';
import { MockMediaSourceProvider } from '../src/storage/mock-media-source-provider';
import { MockStorageProvider } from '../src/storage/mock-storage-provider';
import { MediaDownload, MediaUnavailable } from '../src/storage/media-source-provider';

const tenant = '00000000-0000-4000-8000-000000000001';
const bytes = Uint8Array.from([1, 2, 3]);
const checksum = createHash('sha256').update(bytes).digest('hex');

function subject(
  fixture: MediaDownload = { contentType: 'image/png', body: bytes, checksumSha256: checksum },
) {
  const storage = new MockStorageProvider(10, 20);
  return {
    storage,
    ingestor: new MediaIngestor(new MockMediaSourceProvider({ media_1: fixture }), storage, 4),
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
      { contentType: 'image/png', body: Uint8Array.from([1, 2, 3, 4, 5]) },
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
