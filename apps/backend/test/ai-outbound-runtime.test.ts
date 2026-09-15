import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dependencies } from '../src/dependencies';
import { SecretResolver } from '../src/secrets/secret-resolver';
import { startAIAutomaticOutboundRuntime } from '../src/ai/ai-outbound-runtime';

class MemorySecrets implements SecretResolver {
  resolve(): Promise<string> {
    return Promise.resolve('synthetic-server-access-token');
  }
}

test('automatic outbound runtime requires valid WhatsApp API version before queue start', async () => {
  let starts = 0;
  const startQueue = async () => {
    starts += 1;
    return async () => undefined;
  };
  const deps = {} as Dependencies;
  await assert.rejects(
    () =>
      startAIAutomaticOutboundRuntime(
        deps,
        {
          redisUrl: 'redis://localhost:6379',
          whatsappApiVersion: 'latest',
          secretResolver: new MemorySecrets(),
        },
        startQueue,
      ),
    /Invalid WhatsApp messaging configuration/,
  );
  assert.equal(starts, 0);
});

test('automatic outbound runtime composes queue only with explicit secret resolver', async () => {
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
  const deps = { db: {} } as Dependencies;
  const stop = await startAIAutomaticOutboundRuntime(
    deps,
    {
      redisUrl: 'redis://localhost:6379/2',
      whatsappApiVersion: 'v23.0',
      secretResolver: new MemorySecrets(),
    },
    startQueue,
  );
  assert.equal(seenRedis, 'redis://localhost:6379/2');
  assert.equal(seenProcessor, true);
  await stop();
});
