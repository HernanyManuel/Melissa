import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalendarProviderConflict,
  CalendarProviderInvalidRequest,
  CalendarProviderUnavailable,
} from '../src/calendar/calendar-provider';
import { CalendarProviderRegistry } from '../src/calendar/calendar-provider-registry';
import { MockCalendarProvider } from '../src/calendar/mock-calendar-provider';

const connection = {
  connectionId: 'connection-a',
  calendarRef: 'calendar-a',
  credentialRef: 'secret://calendar/a',
};

test('mock calendar provider returns bounded busy intervals with defensive copies', async () => {
  const provider = new MockCalendarProvider();
  provider.setBusy(connection.connectionId, [
    { startsAt: '2030-01-01T09:00:00Z', endsAt: '2030-01-01T10:00:00Z' },
    { startsAt: '2030-01-01T12:00:00Z', endsAt: '2030-01-01T13:00:00Z' },
  ]);

  const result = await provider.busy({
    connection,
    startsAt: '2030-01-01T09:30:00Z',
    endsAt: '2030-01-01T12:30:00Z',
  });
  assert.deepEqual(result.intervals, [
    { startsAt: '2030-01-01T09:00:00.000Z', endsAt: '2030-01-01T10:00:00.000Z' },
    { startsAt: '2030-01-01T12:00:00.000Z', endsAt: '2030-01-01T13:00:00.000Z' },
  ]);
  assert(!Number.isNaN(new Date(result.observedAt).valueOf()));

  result.intervals[0]!.startsAt = '2099-01-01T00:00:00.000Z';
  const replay = await provider.busy({
    connection,
    startsAt: '2030-01-01T09:30:00Z',
    endsAt: '2030-01-01T10:30:00Z',
  });
  assert.equal(replay.intervals[0]!.startsAt, '2030-01-01T09:00:00.000Z');
});

test('mock calendar provider makes booking mutations idempotent by connection and operation key', async () => {
  const provider = new MockCalendarProvider();
  const request = {
    connection,
    bookingId: 'booking-a',
    operationKey: 'create-a',
    startsAt: '2030-01-01T10:00:00+00:00',
    endsAt: '2030-01-01T10:30:00+00:00',
    timezone: 'Europe/Lisbon',
  };

  const created = await provider.upsertBooking(request);
  const replay = await provider.upsertBooking(request);
  assert.deepEqual(replay, created);
  assert.equal(created.version, '1');
  assert.equal(created.cancelled, false);

  await assert.rejects(
    provider.upsertBooking({ ...request, startsAt: '2030-01-01T11:00:00Z' }),
    (error) => error instanceof CalendarProviderConflict,
  );

  const rescheduled = await provider.upsertBooking({
    ...request,
    operationKey: 'reschedule-a',
    startsAt: '2030-01-01T11:00:00Z',
    endsAt: '2030-01-01T11:30:00Z',
  });
  assert.equal(rescheduled.externalEventId, created.externalEventId);
  assert.equal(rescheduled.version, '2');

  const cancelled = await provider.cancelBooking({
    connection,
    bookingId: request.bookingId,
    operationKey: 'cancel-a',
  });
  const cancelReplay = await provider.cancelBooking({
    connection,
    bookingId: request.bookingId,
    operationKey: 'cancel-a',
  });
  assert.deepEqual(cancelReplay, cancelled);
  assert.equal(cancelled.externalEventId, created.externalEventId);
  assert.equal(cancelled.version, '3');
  assert.equal(cancelled.cancelled, true);

  const otherConnectionEvent = await provider.upsertBooking({
    ...request,
    connection: { ...connection, connectionId: 'connection-b' },
  });
  assert.notEqual(otherConnectionEvent.externalEventId, created.externalEventId);
});

test('mock calendar provider validates exact instants and fails closed when unavailable', async () => {
  const provider = new MockCalendarProvider();
  await assert.rejects(
    provider.busy({ connection, startsAt: '2030-01-01T10:00:00', endsAt: '2030-01-01T11:00:00Z' }),
    (error) => error instanceof CalendarProviderInvalidRequest,
  );
  await assert.rejects(
    provider.upsertBooking({
      connection,
      bookingId: 'booking-a',
      operationKey: 'invalid-range',
      startsAt: '2030-01-01T11:00:00Z',
      endsAt: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    }),
    (error) => error instanceof CalendarProviderInvalidRequest,
  );

  provider.setAvailable(false);
  await assert.rejects(
    provider.busy({ connection, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' }),
    (error) => error instanceof CalendarProviderUnavailable,
  );
});

test('calendar provider registry rejects duplicate and unknown providers', () => {
  const registry = new CalendarProviderRegistry();
  const provider = new MockCalendarProvider();
  registry.register(provider);
  assert.deepEqual(registry.keys(), ['mock']);
  assert.equal(registry.get('mock'), provider);
  assert.throws(() => registry.register(new MockCalendarProvider()));
  assert.throws(() => registry.get('google'), (error) => error instanceof CalendarProviderUnavailable);
});
