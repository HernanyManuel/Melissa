import { CalendarProviderRegistry } from './calendar-provider-registry';
import {
  CalendarConnectionRef,
  CalendarExternalEvent,
  CalendarProviderUnavailable,
} from './calendar-provider';

export interface BookingCalendarReconciliationTarget {
  tenantId: string;
  connection: CalendarConnectionRef;
  provider: string;
  bookingId: string;
  bookingVersion: number;
  cancelled: boolean;
  externalEventId: string;
  externalVersion: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}

export interface BookingCalendarReconciliationStore {
  targets(limit: number): Promise<BookingCalendarReconciliationTarget[]>;
  persist(
    target: BookingCalendarReconciliationTarget,
    event: CalendarExternalEvent,
  ): Promise<void>;
}

export class BookingCalendarReconciler {
  constructor(
    private readonly store: BookingCalendarReconciliationStore,
    private readonly providers: CalendarProviderRegistry,
  ) {}

  async reconcile(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
    const targets = await this.store.targets(limit);
    let repaired = 0;
    for (const target of targets) {
      const provider = this.providers.get(target.provider);
      if (!provider.booking) throw new CalendarProviderUnavailable();
      const operationKey = `reconcile:${target.bookingId}:${target.bookingVersion}`;
      const remote = await provider.booking({
        connection: target.connection,
        bookingId: target.bookingId,
        operationKey,
      });
      let event: CalendarExternalEvent | null = null;
      if (target.cancelled) {
        if (remote && remote.cancelled && remote.externalEventId === target.externalEventId) continue;
        event = await provider.cancelBooking({
          connection: target.connection,
          bookingId: target.bookingId,
          operationKey,
        });
      } else if (
        !remote ||
        remote.cancelled ||
        remote.externalEventId !== target.externalEventId ||
        remote.startsAt !== target.startsAt ||
        remote.endsAt !== target.endsAt ||
        remote.timezone !== target.timezone
      ) {
        event = await provider.upsertBooking({
          connection: target.connection,
          bookingId: target.bookingId,
          operationKey,
          startsAt: target.startsAt,
          endsAt: target.endsAt,
          timezone: target.timezone,
        });
      } else if (remote.version !== target.externalVersion) {
        event = remote;
      }
      if (event) {
        await this.store.persist(target, event);
        repaired += 1;
      }
    }
    return repaired;
  }
}
