import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { queueConnection } from './queue-connection';
import { InfrastructureModule } from './infrastructure.module';
import { CONFIG, Configuration } from './config';
import { configureHttp } from './http';
import { log } from './logging';
import { Dependencies } from './dependencies';
import { startInboundQueue } from './messaging/inbound-queue';
import { startQuarantineRetention } from './channels/quarantine-retention';

// Isolated probe and durable inbound consumers; no public product API on this process.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(InfrastructureModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  configureHttp(app, config, false);
  const connection = queueConnection(config.REDIS_URL);
  const worker = new Worker(
    'infrastructure',
    async (job) => {
      if (job.name !== 'ping') throw new Error('Unsupported infrastructure job');
      return { status: 'ok' };
    },
    { connection, concurrency: 1 },
  );
  worker.on('error', () => log.error({ event: 'worker_error' }));
  worker.on('failed', () => log.warn({ event: 'infrastructure_job_failed' }));
  // Start probe server only once the actual consumer is ready.
  await worker.waitUntilReady();
  const stopInbound = await startInboundQueue(app.get(Dependencies), config.REDIS_URL);
  const stopRetention = startQuarantineRetention(app.get(Dependencies).db);
  await app.listen(config.WORKER_PORT, '0.0.0.0');
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopRetention();
    await stopInbound();
    await worker.close();
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
