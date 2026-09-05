import assert from 'node:assert/strict';
import test from 'node:test';
import { isMediaIngestionJob } from '../src/storage/media-ingestion-queue';

const id = '00000000-0000-4000-8000-000000000001';

test('media queue accepts only minimal bounded internal jobs', () => {
  for (const attempt of [0, 1, 4])
    assert.equal(isMediaIngestionJob('ingest-media', { id, attempt }), true);
  for (const [name, data] of [
    ['other', { id, attempt: 0 }],
    ['ingest-media', { id: 'invalid', attempt: 0 }],
    ['ingest-media', { id, attempt: -1 }],
    ['ingest-media', { id, attempt: 5 }],
    ['ingest-media', { id, attempt: 1.5 }],
    ['ingest-media', { id, attempt: 0, tenantId: id }],
    ['ingest-media', { id, attempt: 0, mediaId: 'external' }],
    ['ingest-media', null],
  ] as const)
    assert.equal(isMediaIngestionJob(name, data), false);
});
