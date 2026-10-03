import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingCalendarReconciler,
  BookingCalendarReconciliationStore,
  BookingCalendarReconciliationTarget,
} from '../src/calendar/booking-calendar-reconciler';
import {
  CalendarBookingCancellation,
  CalendarBookingMutation,
  CalendarBusyRequest,
  CalendarBusyResult,
  CalendarExternalEvent,
  CalendarManagedBooking,
  CalendarProvider,
} from '../src/calendar/calendar-provider';
import { CalendarProviderRegistry } from '../src/calendar/calendar-provider-registry';

class Store implements BookingCalendarReconciliationStore {
  persisted: CalendarExternalEvent[] = [];
  released = 0;
  constructor(readonly target: BookingCalendarReconciliationTarget) {}
  async targets(): Promise<BookingCalendarReconciliationTarget[]> {
    return [this.target];
  }
  async persist(
    _target: BookingCalendarReconciliationTarget,
    event: CalendarExternalEvent,
  ): Promise<void> {
    this.persisted.push(event);
  }
  async release(_target: BookingCalendarReconciliationTarget): Promise<void> {
    this.released += 1;
  }
}

class Provider implements CalendarProvider {
  readonly providerKey = 'mock';
  reads = 0;
  upserts: CalendarBookingMutation[] = [];
  cancellations: CalendarBookingCancellation[] = [];
  constructor(readonly remote: CalendarManagedBooking | null) {}
  async busy(request: CalendarBusyRequest): Promise<CalendarBusyResult> {
    void request;
    throw new Error('Unexpected busy');
  }
  async booking(request: CalendarBookingCancellation): Promise<CalendarManagedBooking | null> {
    void request;
    this.reads += 1;
    return this.remote;
  }
  async upsertBooking(request: CalendarBookingMutation): Promise<CalendarExternalEvent> {
    this.upserts.push(request);
    return { externalEventId: 'external-1', version: 'repaired', cancelled: false };
  }
  async cancelBooking(request: CalendarBookingCancellation): Promise<CalendarExternalEvent> {
    this.cancellations.push(request);
    return { externalEventId: 'external-1', version: 'cancelled', cancelled: true };
  }
}

function target(cancelled = false): BookingCalendarReconciliationTarget {
  return {
    tenantId: 'tenant-1',
    connection: {
      connectionId: 'connection-1',
      calendarRef: 'calendar-1',
      credentialRef: 'secret://calendar/1',
    },
    provider: 'mock',
    bookingId: 'booking-1',
    bookingVersion: 7,
    cancelled,
    externalEventId: 'external-1',
    externalVersion: 'etag-1',
    startsAt: '2030-01-01T10:00:00.000Z',
    endsAt: '2030-01-01T10:30:00.000Z',
    timezone: 'Europe/Lisbon',
    leaseId: '11111111-1111-4111-8111-111111111111',
  };
}

async function run(remote: CalendarManagedBooking | null, cancelled = false) {
  const store = new Store(target(cancelled));
  const provider = new Provider(remote);
  const registry = new CalendarProviderRegistry();
  registry.register(provider);
  const repaired = await new BookingCalendarReconciler(store, registry).reconcile();
  return { store, provider, repaired };
}

test('booking reconciliation recreates a deleted managed event from Melissa state', async () => {
  const { store, provider, repaired } = await run(null);
  assert.equal(repaired, 1);
  assert.equal(provider.upserts.length, 1);
  assert.equal(provider.upserts[0]?.operationKey, 'reconcile:booking-1:7');
  assert.equal(store.persisted[0]?.version, 'repaired');
});

test('booking reconciliation repairs externally modified booking times', async () => {
  const { provider, repaired } = await run({
    externalEventId: 'external-1',
    version: 'etag-2',
    cancelled: false,
    startsAt: '2030-01-01T12:00:00.000Z',
    endsAt: '2030-01-01T12:30:00.000Z',
    timezone: 'Europe/Lisbon',
  });
  assert.equal(repaired, 1);
  assert.equal(provider.upserts.length, 1);
  assert.equal(provider.upserts[0]?.startsAt, '2030-01-01T10:00:00.000Z');
});

test('booking reconciliation only refreshes projection when content matches but etag changed', async () => {
  const { store, provider, repaired } = await run({
    externalEventId: 'external-1',
    version: 'etag-2',
    cancelled: false,
    startsAt: '2030-01-01T10:00:00.000Z',
    endsAt: '2030-01-01T10:30:00.000Z',
    timezone: 'Europe/Lisbon',
  });
  assert.equal(repaired, 1);
  assert.equal(provider.upserts.length, 0);
  assert.equal(provider.cancellations.length, 0);
  assert.equal(store.persisted[0]?.version, 'etag-2');
});

test('booking reconciliation cancels an externally resurrected cancelled booking', async () => {
  const { store, provider, repaired } = await run(
    {
      externalEventId: 'external-1',
      version: 'etag-live',
      cancelled: false,
      startsAt: '2030-01-01T10:00:00.000Z',
      endsAt: '2030-01-01T10:30:00.000Z',
      timezone: 'Europe/Lisbon',
    },
    true,
  );
  assert.equal(repaired, 1);
  assert.equal(provider.cancellations.length, 1);
  assert.equal(store.persisted[0]?.cancelled, true);
});

test('booking reconciliation releases the lease when state is already convergent', async () => {
  const { store, provider, repaired } = await run({
    externalEventId: 'external-1',
    version: 'etag-1',
    cancelled: false,
    startsAt: '2030-01-01T10:00:00.000Z',
    endsAt: '2030-01-01T10:30:00.000Z',
    timezone: 'Europe/Lisbon',
  });
  assert.equal(repaired, 0);
  assert.equal(provider.upserts.length, 0);
  assert.equal(store.persisted.length, 0);
  assert.equal(store.released, 1);
});
