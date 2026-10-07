import { Queue, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { log } from '../logging';
import { queueConnection } from '../queue-connection';
import { HumanOutboundDispatcher } from './human-outbound-dispatcher';

export function isHumanOutboundJob(
  name: string,
  data: unknown,
): data is { id: string; attempt: number } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  return (
    name === 'human-outbound' &&
    typeof value.id === 'string' &&
    isUUID(value.id) &&
    typeof value.attempt === 'number' &&
    Number.isInteger(value.attempt) &&
    value.attempt >= 0 &&
    value.attempt < 5 &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => ['id', 'attempt'].includes(key))
  );
}

export async function startHumanOutboundQueue(
  deps: Pick<Dependencies, 'db'>,
  redisUrl: string,
  processor: HumanOutboundDispatcher,
): Promise<() => Promise<void>> {
  const connection = queueConnection(redisUrl);
  const queue = new Queue('human-outbound', {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 3000,
    },
  });
  const worker = new Worker<{ id: string; attempt: number }>(
    'human-outbound',
    async (job) => {
      if (!isHumanOutboundJob(job.name, job.data)) throw new Error('Invalid human outbound job');
      await processor.process(job.data.id, job.data.attempt);
    },
    { connection, concurrency: 2, lockDuration: 30000, maxStalledCount: 2 },
  );
  worker.on('error', () => log.error({ event: 'human_outbound_worker_error' }));
  worker.on('failed', () => log.warn({ event: 'human_outbound_job_failed' }));
  queue.on('error', () => log.error({ event: 'human_outbound_queue_error' }));
  await worker.waitUntilReady();

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      const pending = await deps.db.humanOutboundDispatch.findMany({
        where: { state: 'pending', nextAttemptAt: { lte: new Date() } },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });
      for (const item of pending) {
        if (stopping) break;
        await queue.add(
          'human-outbound',
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
      log.warn({ event: 'human_outbound_dispatch_retry' });
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
