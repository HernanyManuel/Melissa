import { Dependencies } from '../dependencies';
import { SecretResolver } from '../secrets/secret-resolver';
import { CalendarProviderRegistry } from './calendar-provider-registry';
import { startCalendarSyncQueue } from './calendar-sync-queue';
import { CalendarSyncService } from './calendar-sync-service';
import { GoogleCalendarProvider } from './google-calendar-provider';

export interface CalendarSyncRuntimeOptions {
  redisUrl: string;
  secretResolver: SecretResolver;
}

type QueueStarter = typeof startCalendarSyncQueue;

/**
 * Composes the live calendar sync consumer. Construction performs no provider I/O
 * or secret resolution; credentials are resolved only when a Google job executes.
 */
export async function startCalendarSyncRuntime(
  deps: Dependencies,
  options: CalendarSyncRuntimeOptions,
  startQueue: QueueStarter = startCalendarSyncQueue,
): Promise<() => Promise<void>> {
  const providers = new CalendarProviderRegistry();
  providers.register(new GoogleCalendarProvider(options.secretResolver));
  const service = new CalendarSyncService(deps, providers);
  return startQueue(options.redisUrl, service);
}
