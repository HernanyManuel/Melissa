import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarSyncService } from '../src/calendar/calendar-sync-service';
import { startCalendarSyncRuntime } from '../src/calendar/calendar-sync-runtime';
import { Dependencies } from '../src/dependencies';
import { SecretResolver } from '../src/secrets/secret-resolver';

class CountingSecrets implements SecretResolver {
  calls = 0;

  async resolve(): Promise<string> {
    this.calls += 1;
    throw new Error('runtime construction must not resolve secrets');
  }
}

test('calendar sync runtime is opt-in composition without provider I/O at construction', async () => {
  const secrets = new CountingSecrets();
  let receivedService: CalendarSyncService | undefined;
  let stopped = false;
  const stop = await startCalendarSyncRuntime(
    {} as Dependencies,
    { redisUrl: 'redis://localhost:6379', secretResolver: secrets },
    async (redisUrl, service) => {
      assert.equal(redisUrl, 'redis://localhost:6379');
      receivedService = service;
      return async () => {
        stopped = true;
      };
    },
  );

  assert(receivedService instanceof CalendarSyncService);
  assert.equal(secrets.calls, 0);
  await stop();
  assert.equal(stopped, true);
});
