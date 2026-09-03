import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { Queue, QueueEvents } from 'bullmq';
import { queueConnection } from '../src/queue-connection';
import { setTimeout as delay } from 'node:timers/promises';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { configureHttp } from '../src/http';
import { ConversationLock } from '../src/messaging/conversation-lock';
import { randomUUID } from 'node:crypto';

test(
  'real dependencies, HTTP probes, sanitization and worker round-trip',
  { timeout: 30000 },
  async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    const config = app.get<Configuration>(CONFIG);
    configureHttp(app, config, false);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    try {
      const live = await fetch(origin + '/health/live');
      assert.equal(live.status, 200);
      assert(live.headers.get('x-request-id'));
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await fetch(origin + '/health/ready')).ok) break;
        await delay(100);
      }
      assert.equal((await fetch(origin + '/health/ready')).status, 200);
      const missing = await fetch(origin + '/not-a-route?token=do-not-log');
      assert.equal(missing.status, 404);
      const body = await missing.text();
      assert(!body.includes('do-not-log'));
      assert(!body.includes('stack'));
      const connection = queueConnection(config.REDIS_URL);
      const queue = new Queue('infrastructure', { connection });
      const events = new QueueEvents('infrastructure', { connection });
      try {
        await events.waitUntilReady();
        const job = await queue.add(
          'ping',
          {},
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 200 },
            // Retain a bounded result set so a fast worker cannot delete the result
            // before waitUntilFinished registers its listener.
            removeOnComplete: 100,
            removeOnFail: 10,
          },
        );
        assert.deepEqual(await job.waitUntilFinished(events, 10000), { status: 'ok' });
      } finally {
        await events.close();
        await queue.close();
      }
      const redis = app.get(Dependencies).redis;
      const lockKey = `test:conversation-lock:${randomUUID()}`;
      const lock = new ConversationLock(redis, 1500);
      try {
        assert.equal(
          await lock.run(lockKey, async (owned) => {
            assert.equal(
              await lock.run(lockKey, async () => assert.fail('Concurrent holder')),
              false,
            );
            await delay(1800);
            await owned();
            assert.equal(await lock.run(lockKey, async () => assert.fail('Renewal failed')), false);
          }),
          true,
        );
        assert.equal(await redis.get(lockKey), null);
        await assert.rejects(
          lock.run(lockKey, async (owned) => {
            await redis.set(lockKey, 'successor', 'PX', 10000);
            await owned();
          }),
          /lease lost/,
        );
        assert.equal(
          await redis.get(lockKey),
          'successor',
          'Old holder must not release successor',
        );
      } finally {
        await redis.del(lockKey);
      }
      // A dependency outage must fail readiness without killing liveness.
      app.get(Dependencies).redis.disconnect();
      assert.equal((await fetch(origin + '/health/ready')).status, 503);
      assert.equal((await fetch(origin + '/health/live')).status, 200);
    } finally {
      await app.close();
    }
  },
);
