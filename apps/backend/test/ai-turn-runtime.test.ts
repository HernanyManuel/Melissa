import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { startAITurnRuntime } from '../src/ai/ai-turn-runtime';

const base = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/4',
};

test('AI turn runtime fails before queue start when provider is disabled', async () => {
  let starts = 0;
  const startQueue = async () => {
    starts += 1;
    return async () => undefined;
  };
  await assert.rejects(
    () => startAITurnRuntime({} as Dependencies, parseConfig(base), startQueue),
    /requires an explicit provider/,
  );
  assert.equal(starts, 0);
});

test('AI turn runtime composes server-owned processor with explicit mock provider', async () => {
  let seenRedis = '';
  let seenProcessor = false;
  const startQueue = async (
    _deps: Pick<Dependencies, 'db'>,
    redisUrl: string,
    processor: unknown,
  ) => {
    seenRedis = redisUrl;
    seenProcessor = typeof processor === 'object' && processor !== null;
    return async () => undefined;
  };
  const config = parseConfig({ ...base, AI_PROVIDER: 'mock' });
  const stop = await startAITurnRuntime({ db: {} } as Dependencies, config, startQueue);
  assert.equal(seenRedis, base.REDIS_URL);
  assert.equal(seenProcessor, true);
  await stop();
});
