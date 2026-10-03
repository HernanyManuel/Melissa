import { Queue, Worker } from 'bullmq';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { log } from '../logging';
import { queueConnection } from '../queue-connection';
import { BookingCalendarDispatchStore } from './booking-calendar-dispatch-store';
import { BookingCalendarProcessor } from './booking-calendar-processor';
import { BookingCalendarReconciler } from './booking-calendar-reconciler';
import { PrismaBookingCalendarReconciliationStore } from './booking-calendar-reconciliation-store';
import { CalendarProvider } from './calendar-provider';
import { CalendarProviderRegistry } from './calendar-provider-registry';
import { GoogleCalendarProvider } from './google-calendar-provider';
import { SecretResolver } from '../secrets/secret-resolver';

const QUEUE = 'booking-calendar-dispatch';
const INTERVAL_MS = 1000;
const RECONCILIATION_INTERVAL_MS = 60_000;

interface DispatchJob {
  id: string;
  attempt: number;
}

export function isDispatchJob(name: string, data: unknown): data is DispatchJob {
  if (
    name !== 'booking-calendar-dispatch' ||
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  )
    return false;
  const value = data as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    typeof value.id === 'string' &&
    isUUID(value.id) &&
    Number.isInteger(value.attempt) &&
    Number(value.attempt) >= 0 &&
    Number(value.attempt) < 5
  );
}

export interface BookingCalendarRuntimeOptions {
  provider?: CalendarProvider;
}

export async function startBookingCalendarRuntime(
  deps: Dependencies,
  redisUrl: string,
  secrets: SecretResolver,
  options: BookingCalendarRuntimeOptions = {},
): Promise<() => Promise<void>> {
  const store = new BookingCalendarDispatchStore(deps);
  const providers = new CalendarProviderRegistry();
  providers.register(options.provider ?? new GoogleCalendarProvider(secrets));
  const processor = new BookingCalendarProcessor(store, (key) => {
    try {
      return providers.get(key);
    } catch {
      return null;
    }
  });
  const reconciler = new BookingCalendarReconciler(
    new PrismaBookingCalendarReconciliationStore(deps),
    providers,
  );
  const queue = new Queue<DispatchJob>(QUEUE, { connection: queueConnection(redisUrl) });
  const worker = new Worker<DispatchJob>(
    QUEUE,
    async (job) => {
      if (!isDispatchJob(job.name, job.data)) throw new Error('Invalid booking calendar job');
      await processor.process(job.data);
    },
    {
      connection: queueConnection(redisUrl),
      concurrency: 2,
      lockDuration: 60000,
      maxStalledCount: 1,
    },
  );
  worker.on('error', () => log.error({ event: 'booking_calendar_worker_error' }));
  worker.on('failed', () => log.warn({ event: 'booking_calendar_job_failed' }));
  await worker.waitUntilReady();

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const dispatch = async (): Promise<void> => {
    try {
      for (const route of await store.due()) {
        if (stopping) break;
        await queue.add('booking-calendar-dispatch', route, {
          jobId: `${route.id}-${route.attempt}`,
          removeOnComplete: true,
          removeOnFail: 100,
        });
      }
    } catch {
      log.warn({ event: 'booking_calendar_dispatch_retry' });
    }
    if (!stopping) timer = setTimeout(() => void (running = dispatch()), INTERVAL_MS);
  };
  running = dispatch();

  let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
  let reconciliationRunning: Promise<void> = Promise.resolve();
  const reconcile = async (): Promise<void> => {
    try {
      await reconciler.reconcile(100);
    } catch {
      log.warn({ event: 'booking_calendar_reconciliation_retry' });
    }
    if (!stopping)
      reconciliationTimer = setTimeout(
        () => void (reconciliationRunning = reconcile()),
        RECONCILIATION_INTERVAL_MS,
      );
  };
  reconciliationRunning = reconcile();

  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    if (reconciliationTimer) clearTimeout(reconciliationTimer);
    await running;
    await reconciliationRunning;
    await queue.close();
    await worker.close();
  };
}
