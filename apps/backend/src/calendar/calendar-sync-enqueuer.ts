import { Queue } from 'bullmq';
import { log } from '../logging';
import { queueConnection } from '../queue-connection';

export interface CalendarSyncTarget {
  tenantId: string;
  connectionId: string;
}

export interface CalendarSyncWindow {
  startsAt: string;
  endsAt: string;
}

export async function enqueueCalendarSync(
  redisUrl: string,
  target: CalendarSyncTarget,
  window: CalendarSyncWindow,
): Promise<void> {
  const enqueuer = new CalendarSyncEnqueuer(redisUrl);
  try {
    await enqueuer.enqueue(target, window);
  } finally {
    await enqueuer.close();
  }
}

export class CalendarSyncEnqueuer {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.queue = new Queue('calendar-sync', {
      connection: {
        ...queueConnection(redisUrl),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 3000,
      },
    });
    this.queue.on('error', () => log.error({ event: 'calendar_sync_queue_error' }));
  }

  async enqueue(target: CalendarSyncTarget, window: CalendarSyncWindow): Promise<void> {
    await this.queue.add(
      'calendar-sync-busy',
      { ...target, ...window },
      {
        jobId: `${target.connectionId}-${window.startsAt}-${window.endsAt}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
