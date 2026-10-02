import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookingCalendarProcessor } from '../src/calendar/booking-calendar-processor';
import {
  BookingCalendarDispatchClaim,
  BookingCalendarDispatchRoute,
} from '../src/calendar/booking-calendar-dispatch-store';
import { CalendarProvider } from '../src/calendar/calendar-provider';

const route: BookingCalendarDispatchRoute = { id: 'dispatch-a', attempt: 0 };
const baseClaim: BookingCalendarDispatchClaim = {
  id: route.id,
  tenantId: 'tenant-a',
  bookingId: 'booking-a',
  eventType: 'created',
  bookingVersion: 3,
  connectionId: 'connection-a',
  provider: 'mock',
  calendarRef: 'calendar-a',
  credentialRef: null,
  attempt: 0,
};

function harness(claim: BookingCalendarDispatchClaim = baseClaim) {
  const accepted: BookingCalendarDispatchClaim[] = [];
  const failed: BookingCalendarDispatchClaim[] = [];
  const calls: Array<{ kind: string; request: unknown }> = [];
  const store = {
    claim: async () => claim,
    bookingSnapshot: async () => ({
      startsAt: '2030-01-01T10:00:00.000Z',
      endsAt: '2030-01-01T10:30:00.000Z',
      timezone: 'Europe/Lisbon',
    }),
    accept: async (value: BookingCalendarDispatchClaim) => {
      accepted.push(value);
    },
    recordFailure: async (value: BookingCalendarDispatchClaim) => {
      failed.push(value);
    },
  };
  const provider: CalendarProvider = {
    providerKey: claim.provider,
    busy: async () => ({ observedAt: '', intervals: [], syncToken: null }),
    upsertBooking: async (request) => {
      calls.push({ kind: 'upsert', request });
      return { externalEventId: 'event-a', version: 'v1', cancelled: false };
    },
    cancelBooking: async (request) => {
      calls.push({ kind: 'cancel', request });
      return { externalEventId: 'event-a', version: 'v1', cancelled: true };
    },
  };
  return { store, provider, accepted, failed, calls };
}

test('booking calendar processor upserts with deterministic operation key', async () => {
  const h = harness();
  const processor = new BookingCalendarProcessor(h.store as never, () => h.provider);
  assert.equal(await processor.process(route), true);
  assert.equal(h.failed.length, 0);
  assert.equal(h.accepted.length, 1);
  assert.deepEqual(h.calls, [
    {
      kind: 'upsert',
      request: {
        connection: {
          connectionId: 'connection-a',
          calendarRef: 'calendar-a',
          credentialRef: '',
        },
        bookingId: 'booking-a',
        operationKey: 'booking-a:created:3',
        startsAt: '2030-01-01T10:00:00.000Z',
        endsAt: '2030-01-01T10:30:00.000Z',
        timezone: 'Europe/Lisbon',
      },
    },
  ]);
});

test('booking calendar processor cancels without loading a booking snapshot', async () => {
  const h = harness({ ...baseClaim, eventType: 'cancelled', bookingVersion: 4 });
  h.store.bookingSnapshot = async () => assert.fail('cancel must not load booking snapshot');
  const processor = new BookingCalendarProcessor(h.store as never, () => h.provider);
  assert.equal(await processor.process(route), true);
  assert.deepEqual(h.calls[0], {
    kind: 'cancel',
    request: {
      connection: {
        connectionId: 'connection-a',
        calendarRef: 'calendar-a',
        credentialRef: '',
      },
      bookingId: 'booking-a',
      operationKey: 'booking-a:cancelled:4',
    },
  });
});

test('booking calendar processor fails closed without provider or Google credential', async () => {
  const missing = harness();
  assert.equal(
    await new BookingCalendarProcessor(missing.store as never, () => null).process(route),
    false,
  );
  assert.equal(missing.failed.length, 1);

  const google = harness({ ...baseClaim, provider: 'google', credentialRef: null });
  assert.equal(
    await new BookingCalendarProcessor(google.store as never, () => google.provider).process(route),
    false,
  );
  assert.equal(google.calls.length, 0);
  assert.equal(google.failed.length, 1);
});

test('booking calendar processor contains sensitive provider errors and records failure', async () => {
  const h = harness();
  h.provider.upsertBooking = async () => {
    throw new Error('access_token=secret-token credential=secret-ref');
  };
  const processor = new BookingCalendarProcessor(h.store as never, () => h.provider);
  await assert.doesNotReject(async () => {
    assert.equal(await processor.process(route), false);
  });
  assert.equal(h.accepted.length, 0);
  assert.equal(h.failed.length, 1);
});
