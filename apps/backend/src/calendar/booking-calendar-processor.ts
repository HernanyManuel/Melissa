import {
  CalendarConnectionRef,
  CalendarProvider,
  CalendarProviderUnavailable,
} from './calendar-provider';
import {
  BookingCalendarDispatchClaim,
  BookingCalendarDispatchRoute,
  BookingCalendarDispatchStore,
} from './booking-calendar-dispatch-store';

export interface CalendarProviderResolver {
  (providerKey: string): CalendarProvider | null;
}

export class BookingCalendarProcessor {
  constructor(
    private readonly store: BookingCalendarDispatchStore,
    private readonly providerFor: CalendarProviderResolver,
  ) {}

  async process(route: BookingCalendarDispatchRoute): Promise<boolean> {
    const claim = await this.store.claim(route.id, route.attempt);
    if (!claim) return false;
    try {
      const provider = this.providerFor(claim.provider);
      if (!provider || provider.providerKey !== claim.provider) {
        throw new CalendarProviderUnavailable();
      }
      const connection = this.connection(claim);
      const operationParts = [claim.bookingId, claim.eventType, claim.bookingVersion];
      const operationKey = operationParts.join(':');
      const event =
        claim.eventType === 'cancelled'
          ? await provider.cancelBooking({
          connection,
          bookingId: claim.bookingId,
              operationKey,
            })
          : await this.upsert(provider, claim, connection, operationKey);
      await this.store.accept(claim, event);
      return true;
    } catch {
      await this.store.recordFailure(claim);
      return false;
    }
  }

  private async upsert(
    provider: CalendarProvider,
    claim: BookingCalendarDispatchClaim,
    connection: CalendarConnectionRef,
    operationKey: string,
  ) {
    const snapshot = await this.store.bookingSnapshot(claim);
    if (!snapshot) throw new CalendarProviderUnavailable();
    return provider.upsertBooking({
      connection,
      bookingId: claim.bookingId,
      operationKey,
      ...snapshot,
    });
  }

  private connection(claim: BookingCalendarDispatchClaim): CalendarConnectionRef {
    if (claim.provider === 'google' && !claim.credentialRef) {
      throw new CalendarProviderUnavailable();
    }
    return {
      connectionId: claim.connectionId,
      calendarRef: claim.calendarRef,
      credentialRef: claim.credentialRef ?? '',
    };
  }
}
