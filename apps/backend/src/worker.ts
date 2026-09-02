import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { AppModule } from './app.module';
import { CONFIG, Configuration } from './config';
import { configureHttp } from './http';
import { log } from './logging';

// Infrastructure queue only. No tenant/business jobs before Phase 2 isolation.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  configureHttp(app, config, false);
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', () => log.warn({ event: 'worker_connection_unavailable' }));
  const worker = new Worker('infrastructure', async (job) => {
    if (job.name !== 'ping') throw new Error('Unsupported infrastructure job');
    return { status: 'ok' };
  }, { connection, concurrency: 1 });
  worker.on('error', () => log.error({ event: 'worker_error' }));
  worker.on('failed', () => log.warn({ event: 'infrastructure_job_failed' }));
  // Start probe server only once the actual consumer is ready.
  await worker.waitUntilReady();
  await app.listen(config.WORKER_PORT, '0.0.0.0');
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await worker.close();
    connection.disconnect();
    await app.close();
  };
  // Own shutdown order: stop consumption before closing shared dependencies.
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  log.info({ event: 'worker_started' });
}
void bootstrap().catch(() => {
  log.error({ event: 'worker_start_failed' });
  process.exit(1);
});
