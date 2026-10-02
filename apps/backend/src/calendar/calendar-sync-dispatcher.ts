import { PrismaClient } from '@prisma/client';
import { log } from '../logging';
import { CalendarSyncEnqueuer } from './calendar-sync-enqueuer';

const PAST_COVERAGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_COVERAGE_MS = 90 * 24 * 60 * 60 * 1000;
const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

interface ConnectedCalendar {
  tenantId: string;
  connectionId: string;
}

export function calendarSyncWindow(now: Date): { startsAt: string; endsAt: string } {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid calendar sync clock');
  const bucket = Math.floor(now.getTime() / DISPATCH_INTERVAL_MS) * DISPATCH_INTERVAL_MS;
  return {
    startsAt: new Date(bucket - PAST_COVERAGE_MS).toISOString(),
    endsAt: new Date(bucket + FUTURE_COVERAGE_MS).toISOString(),
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
  const enqueuer = new CalendarSyncEnqueuer(redisUrl);

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      const window = calendarSyncWindow(now());
      for (const item of await discoverConnectedCalendars(db)) {
        if (stopping) break;
        await enqueuer.enqueue(item, window);
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
    await enqueuer.close();
  };
}
