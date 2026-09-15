import { Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { log } from '../logging';
import { queueConnection } from '../queue-connection';
import { CalendarSyncService } from './calendar-sync-service';

const MAX_SYNC_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;
const OFFSET_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/i;

export interface CalendarSyncJob {
  tenantId: string;
  connectionId: string;
  startsAt: string;
  endsAt: string;
}

export function isCalendarSyncJob(name: string, data: unknown): data is CalendarSyncJob {
  if (name !== 'calendar-sync-busy' || !data || typeof data !== 'object' || Array.isArray(data))
    return false;
  const value = data as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    !Object.keys(value).every((key) =>
      ['tenantId', 'connectionId', 'startsAt', 'endsAt'].includes(key),
    ) ||
    typeof value.tenantId !== 'string' ||
    !isUUID(value.tenantId) ||
    typeof value.connectionId !== 'string' ||
    !isUUID(value.connectionId) ||
    typeof value.startsAt !== 'string' ||
    !OFFSET_TIMESTAMP.test(value.startsAt) ||
    typeof value.endsAt !== 'string' ||
    !OFFSET_TIMESTAMP.test(value.endsAt)
  )
    return false;

  const startsAt = new Date(value.startsAt);
  const endsAt = new Date(value.endsAt);
  const windowMs = endsAt.getTime() - startsAt.getTime();
  return (
    !Number.isNaN(startsAt.getTime()) &&
    !Number.isNaN(endsAt.getTime()) &&
    windowMs > 0 &&
    windowMs <= MAX_SYNC_WINDOW_MS
  );
}

export async function startCalendarSyncQueue(
  redisUrl: string,
  service: CalendarSyncService,
): Promise<() => Promise<void>> {
  const worker = new Worker<CalendarSyncJob>(
    'calendar-sync',
    async (job) => {
      if (!isCalendarSyncJob(job.name, job.data)) throw new Error('Invalid calendar sync job');
      await service.syncBusy({
        tenantId: job.data.tenantId,
        connectionId: job.data.connectionId,
        startsAt: new Date(job.data.startsAt),
        endsAt: new Date(job.data.endsAt),
      });
    },
    {
      connection: queueConnection(redisUrl),
      concurrency: 2,
      lockDuration: 60000,
      maxStalledCount: 1,
    },
  );
  worker.on('error', () => log.error({ event: 'calendar_sync_worker_error' }));
  worker.on('failed', () => log.warn({ event: 'calendar_sync_job_failed' }));
  await worker.waitUntilReady();
  return async () => worker.close();
}
