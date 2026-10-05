import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reencryptCalendarCredentials } from '../src/calendar/calendar-credential-key-rotation';
import { CalendarCredentialStore } from '../src/calendar/calendar-credential-store';
import { Dependencies } from '../src/dependencies';

const target = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  keyId: 'calendar-v1',
};

function depsWithBatches(batches: Array<Array<typeof target>>): Dependencies {
  return {
    db: {
      $queryRaw: async () => batches.shift() ?? [],
    },
  } as unknown as Dependencies;
}

function store(read: (reference: string) => Promise<unknown>): CalendarCredentialStore {
  return {
    currentKeyId: 'calendar-v2',
    read,
  } as unknown as CalendarCredentialStore;
}

test('calendar credential key sweep migrates all discovered old-key rows', async () => {
  const references: string[] = [];
  const credentials = store(async (reference) => {
    references.push(reference);
    return {};
  });
  const migrated = await reencryptCalendarCredentials(depsWithBatches([[target], []]), credentials);

  assert.equal(migrated, 1);
  assert.deepEqual(references, [
    'secret://calendar-db/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
  ]);
});

test('calendar credential key sweep blocks retirement when an old key is unavailable', async () => {
  const credentials = store(async () => {
    throw new Error('secret material unavailable');
  });
  await assert.rejects(
    () => reencryptCalendarCredentials(depsWithBatches([[target]]), credentials),
    /rotation is blocked/,
  );
});

test('calendar credential key sweep fails closed when migration does not converge', async () => {
  const credentials = store(async () => ({}));
  await assert.rejects(
    () => reencryptCalendarCredentials(depsWithBatches([[target], [target]]), credentials),
    /did not converge/,
  );
});
