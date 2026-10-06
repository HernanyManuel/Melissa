import { Queue, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { log } from '../logging';
import { queueConnection } from '../queue-connection';

export interface AITurnJobProcessor {
  process(id: string, attempt: number): Promise<void>;
}

export function isAITurnJob(name: string, data: unknown): data is { id: string; attempt: number } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  return (
    name === 'ai-conversation-turn' &&
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

type AbandonedAITurn = {
  tenantId: string;
  id: string;
  dispatchState: string;
};

export async function reconcileAbandonedAITurns(deps: Pick<Dependencies, 'db'>): Promise<void> {
  const abandoned = await deps.db.$queryRaw<AbandonedAITurn[]>`
    SELECT tenant_id AS "tenantId", id, dispatch_state AS "dispatchState"
    FROM discover_abandoned_ai_turns(100)`;
  for (const turn of abandoned) {
    await deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${turn.tenantId}, true)`;
      if (turn.dispatchState === 'pending') {
        await tx.$executeRaw`
          UPDATE ai_turn_dispatch
          SET next_attempt_at=CURRENT_TIMESTAMP
          WHERE tenant_id=${turn.tenantId}::uuid AND id=${turn.id}::uuid
            AND state='pending' AND attempts < 5`;
        return;
      }
      await tx.$executeRaw`
        UPDATE ai_turns
        SET status='failed', failure_code='execution_abandoned',
            completed_at=CURRENT_TIMESTAMP,
            execution_lease_id=NULL, execution_lease_expires_at=NULL
        WHERE tenant_id=${turn.tenantId}::uuid AND id=${turn.id}::uuid
          AND status='running'
          AND execution_lease_id IS NOT NULL
          AND execution_lease_expires_at <= CURRENT_TIMESTAMP`;
    });
  }
}

export async function startAITurnQueue(
  deps: Pick<Dependencies, 'db'>,
  redisUrl: string,
  processor: AITurnJobProcessor,
): Promise<() => Promise<void>> {
  const connection = queueConnection(redisUrl);
  const queue = new Queue('ai-conversation-turns', {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 3000,
    },
  });
  const worker = new Worker<{ id: string; attempt: number }>(
    'ai-conversation-turns',
    async (job) => {
      if (!isAITurnJob(job.name, job.data)) throw new Error('Invalid AI turn job');
      await processor.process(job.data.id, job.data.attempt);
    },
    { connection, concurrency: 2, lockDuration: 60000, maxStalledCount: 1 },
  );
  worker.on('error', () => log.error({ event: 'ai_turn_worker_error' }));
  worker.on('failed', () => log.warn({ event: 'ai_turn_job_failed' }));
  queue.on('error', () => log.error({ event: 'ai_turn_queue_error' }));
  await worker.waitUntilReady();

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      await reconcileAbandonedAITurns(deps);
      const pending = await deps.db.$queryRaw<
        Array<{ id: string; attempts: number }>
      >`SELECT id, attempts FROM ai_turn_dispatch
        WHERE state='pending' AND next_attempt_at <= CURRENT_TIMESTAMP
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT 50`;
      for (const item of pending) {
        if (stopping) break;
        if (
          !isUUID(item.id) ||
          !Number.isInteger(item.attempts) ||
          item.attempts < 0 ||
          item.attempts >= 5
        )
          continue;
        await queue.add(
          'ai-conversation-turn',
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
      log.warn({ event: 'ai_turn_dispatch_retry' });
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
