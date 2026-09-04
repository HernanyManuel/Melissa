import assert from 'node:assert/strict';
import test from 'node:test';
import { MockStorageProvider } from '../src/storage/mock-storage-provider';
import { StorageCapacityExceeded, StoragePayloadConflict } from '../src/storage/storage-provider';

const key = 'tenants/00000000-0000-4000-8000-000000000001/media/object-1';

test('mock storage is idempotent, bounded and uses defensive copies', async () => {
  const storage = new MockStorageProvider(4, 6);
  const input = Uint8Array.from([1, 2, 3]);
  const [first, replay] = await Promise.all([
    storage.put({ key, contentType: 'image/png', body: input }),
    storage.put({ key, contentType: 'image/png', body: input }),
  ]);
  assert.deepEqual(first, replay);
  input[0] = 99;
  const stored = await storage.get(key);
  assert.deepEqual(stored?.body, Uint8Array.from([1, 2, 3]));
  stored!.body[0] = 88;
  assert.deepEqual((await storage.get(key))?.body, Uint8Array.from([1, 2, 3]));
  await assert.rejects(
    storage.put({ key, contentType: 'image/png', body: Uint8Array.from([1, 2, 4]) }),
    StoragePayloadConflict,
  );
  await storage.put({
    key: `${key}-2`,
    contentType: 'text/plain',
    body: Uint8Array.from([4, 5, 6]),
  });
  await assert.rejects(
    storage.put({ key: `${key}-3`, contentType: 'text/plain', body: Uint8Array.from([7]) }),
    StorageCapacityExceeded,
  );
  assert.equal(await storage.delete(key), true);
  assert.equal(await storage.delete(key), false);
  assert.equal(await storage.get(key), null);
});

test('mock storage rejects unsafe keys, types, empty and oversized bodies', async () => {
  const storage = new MockStorageProvider(2, 4);
  for (const unsafe of [
    '',
    '/root',
    '../object',
    'tenant/',
    'tenant//object',
    'tenant/object.json?token=x',
  ])
    await assert.rejects(storage.get(unsafe), /Invalid storage key/);
  await assert.rejects(
    storage.put({ key, contentType: 'IMAGE/PNG', body: Uint8Array.from([1]) }),
    /Invalid storage content type/,
  );
  await assert.rejects(
    storage.put({ key, contentType: 'image/png', body: new Uint8Array() }),
    /Invalid storage body/,
  );
  await assert.rejects(
    storage.put({ key, contentType: 'image/png', body: Uint8Array.from([1, 2, 3]) }),
    StorageCapacityExceeded,
  );
});
