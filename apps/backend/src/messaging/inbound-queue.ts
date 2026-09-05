import { Queue, Worker } from 'bullmq';
import { Dependencies } from '../dependencies';
import { queueConnection } from '../queue-connection';
import { log } from '../logging';
import { InboundProcessor } from './inbound-processor';

export async function startInboundQueue(
  deps: Dependencies,
  redisUrl: string,
): Promise<() => Promise<void>> {
  const connection = queueConnection(redisUrl);
  const queue = new Queue('incoming-messages', {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 3000,
    },
  });
  const processor = new InboundProcessor(deps);
  const worker = new Worker<{ id: string }>(
    'incoming-messages',
    async (job) => {
      if (job.name !== 'mock-inbound' || !/^[0-9a-f-]{36}$/.test(job.data.id))
        throw new Error('Invalid inbound job');
      try {
        await processor.process(job.data.id);
      } catch {
        await processor.recordFailure(job.data.id);
        throw new Error('Inbound processing failed');
      }
    },
    { connection, concurrency: 4, lockDuration: 30000, maxStalledCount: 2 },
  );
  worker.on('error', () => log.error({ event: 'inbound_worker_error' }));
  worker.on('failed', () => log.warn({ event: 'inbound_job_failed' }));
  queue.on('error', () => log.error({ event: 'inbound_queue_error' }));
  await worker.waitUntilReady();
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      const pending = await deps.db.inboundDispatch.findMany({
        where: { state: 'pending', nextAttemptAt: { lte: new Date() } },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });
      for (const item of pending) {
        if (stopping) break;
        await queue.add(
          'mock-inbound',
          { id: item.id },
          {
            jobId: `${item.id}-${item.attempts}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
    } catch {
      log.warn({ event: 'inbound_dispatch_retry' });
    }
    if (!stopping)
      timer = setTimeout(() => {
        running = dispatch();
      }, 1000);
  };
  running = dispatch();
  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await running;
    await worker.close();
    await queue.close();
  };
}
