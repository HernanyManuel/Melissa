import { Queue, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { queueConnection } from '../queue-connection';
import { log } from '../logging';
import { OutboundDispatchProcessor } from './outbound-dispatch-processor';

export async function startOutboundQueue(
  deps: Dependencies,
  redisUrl: string,
): Promise<() => Promise<void>> {
  const connection = queueConnection(redisUrl);
  const queue = new Queue('outgoing-mock-messages', {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 3000,
    },
  });
  const processor = new OutboundDispatchProcessor(deps.db);
  const worker = new Worker<{ id: string; attempt: number }>(
    'outgoing-mock-messages',
    async (job) => {
      if (
        job.name !== 'mock-outbound' ||
        !job.data ||
        typeof job.data.id !== 'string' ||
        !isUUID(job.data.id) ||
        Object.keys(job.data).some((key) => !['id', 'attempt'].includes(key))
      )
        throw new Error('Invalid outbound job');
      await processor.process(job.data.id, job.data.attempt);
    },
    { connection, concurrency: 4, lockDuration: 30000, maxStalledCount: 2 },
  );
  worker.on('error', () => log.error({ event: 'outbound_worker_error' }));
  worker.on('failed', () => log.warn({ event: 'outbound_job_failed' }));
  queue.on('error', () => log.error({ event: 'outbound_queue_error' }));
  await worker.waitUntilReady();
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      const pending = await deps.db.outboundDispatch.findMany({
        where: { state: 'pending', nextAttemptAt: { lte: new Date() } },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });
      for (const item of pending) {
        if (stopping) break;
        await queue.add(
          'mock-outbound',
          { id: item.id, attempt: item.attempts },
          {
            jobId: `${item.id}-${item.attempts}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
    } catch {
      log.warn({ event: 'outbound_dispatch_retry' });
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
