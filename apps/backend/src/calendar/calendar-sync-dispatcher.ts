import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { log } from '../logging';
import { queueConnection } from '../queue-connection';

const PAST_COVERAGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_COVERAGE_MS = 90 * 24 * 60 * 60 * 1000;
const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

interface ConnectedCalendar {
  tenantId: string;
  connectionId: string;
}

export function calendarSyncWindow(now: Date): { startsAt: string; endsAt: string } {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid calendar sync clock');
  return {
    startsAt: new Date(now.getTime() - PAST_COVERAGE_MS).toISOString(),
    endsAt: new Date(now.getTime() + FUTURE_COVERAGE_MS).toISOString(),
  };
}

export async function discoverConnectedCalendars(db: PrismaClient): Promise<ConnectedCalendar[]> {
  return db.$queryRaw<ConnectedCalendar[]>`
    SELECT tenant_id AS "tenantId", id::text AS "connectionId"
    FROM calendar_connections
    WHERE status='connected'
    ORDER BY tenant_id,id
    LIMIT 500
  `;
}

export async function startCalendarSyncDispatcher(
  db: PrismaClient,
  redisUrl: string,
  now: () => Date = () => new Date(),
): Promise<() => Promise<void>> {
  const queue = new Queue('calendar-sync', {
    connection: {
      ...queueConnection(redisUrl),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 3000,
    },
  });
  queue.on('error', () => log.error({ event: 'calendar_sync_queue_error' }));

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      const window = calendarSyncWindow(now());
      for (const item of await discoverConnectedCalendars(db)) {
        if (stopping) break;
        await queue.add(
          'calendar-sync-busy',
          { ...item, ...window },
          {
            jobId: `${item.connectionId}-${window.startsAt}-${window.endsAt}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
      }
    } catch {
      log.warn({ event: 'calendar_sync_dispatch_retry' });
    }
    if (!stopping)
      timer = setTimeout(() => {
        running = dispatch();
      }, DISPATCH_INTERVAL_MS);
  };
  running = dispatch();

  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    await running;
    await queue.close();
  };
}
