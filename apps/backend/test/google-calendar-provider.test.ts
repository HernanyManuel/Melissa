import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CalendarProviderInvalidRequest,
  CalendarProviderUnavailable,
} from '../src/calendar/calendar-provider';
import { GoogleCalendarProvider } from '../src/calendar/google-calendar-provider';
import { SecretResolver } from '../src/secrets/secret-resolver';

class MemorySecrets implements SecretResolver {
  readonly references: string[] = [];

  async resolve(reference: string): Promise<string> {
    this.references.push(reference);
    return 'synthetic-google-access-token';
  }
}

const connection = {
  connectionId: 'connection-google-a',
  calendarRef: 'primary',
  credentialRef: 'secret://tenant/calendar/google',
};

const mutation = {
  connection,
  bookingId: 'booking-a',
  operationKey: 'operation-create-a',
  startsAt: '2030-01-01T10:00:00Z',
  endsAt: '2030-01-01T10:30:00Z',
  timezone: 'Europe/Lisbon',
};

test('Google Calendar busy uses bounded FreeBusy with a server-side bearer secret', async () => {
  const secrets = new MemorySecrets();
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const provider = new GoogleCalendarProvider(secrets, 1000, async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(
      JSON.stringify({
        calendars: {
          primary: {
            busy: [{ start: '2030-01-01T10:00:00Z', end: '2030-01-01T10:30:00Z' }],
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const result = await provider.busy({
    connection,
    startsAt: '2030-01-01T09:00:00Z',
    endsAt: '2030-01-01T12:00:00Z',
    syncToken: 'ignored-full-snapshot-checkpoint',
  });

  assert.equal(seenUrl, 'https://www.googleapis.com/calendar/v3/freeBusy');
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.redirect, 'error');
  assert.equal(
    (seenInit?.headers as Record<string, string>).authorization,
    'Bearer synthetic-google-access-token',
  );
  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    timeMin: '2030-01-01T09:00:00.000Z',
    timeMax: '2030-01-01T12:00:00.000Z',
    items: [{ id: 'primary' }],
  });
  assert.deepEqual(result.intervals, [
    { startsAt: '2030-01-01T10:00:00.000Z', endsAt: '2030-01-01T10:30:00.000Z' },
  ]);
  assert.equal(result.syncToken, null);
  assert.deepEqual(secrets.references, [connection.credentialRef]);
});

test('Google Calendar booking mutation is deterministic, replay-safe and reschedulable', async () => {
  const secrets = new MemorySecrets();
  let stored: Record<string, unknown> | undefined;
  let etag = '"v1"';
  const methods: string[] = [];
  const provider = new GoogleCalendarProvider(secrets, 1000, async (_url, init) => {
    const method = init.method ?? 'GET';
    methods.push(method);
    if (method === 'GET') {
      if (!stored) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ ...stored, etag }), { status: 200 });
    }
    if (method === 'POST') {
      stored = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...stored, etag }), { status: 200 });
    }
    if (method === 'PATCH') {
      stored = { ...stored, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
      etag = '"v2"';
      return new Response(JSON.stringify({ ...stored, etag }), { status: 200 });
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const created = await provider.upsertBooking(mutation);
  assert.match(created.externalEventId, /^[0-9a-f]{32}$/);
  assert.equal(created.version, '"v1"');
  const replay = await provider.upsertBooking(mutation);
  assert.deepEqual(replay, created);
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);

  const rescheduled = await provider.upsertBooking({
    ...mutation,
    operationKey: 'operation-reschedule-a',
    startsAt: '2030-01-01T11:00:00Z',
    endsAt: '2030-01-01T11:30:00Z',
  });
  assert.equal(rescheduled.externalEventId, created.externalEventId);
  assert.equal(rescheduled.version, '"v2"');
  assert.deepEqual(methods, ['GET', 'POST', 'GET', 'GET', 'PATCH']);
});

test('Google Calendar cancellation is idempotent even after the event disappears', async () => {
  let deleted = false;
  const provider = new GoogleCalendarProvider(new MemorySecrets(), 1000, async (_url, init) => {
    if ((init.method ?? 'GET') === 'GET') {
      if (deleted) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({
          id: 'placeholder',
          etag: '"v1"',
          start: { dateTime: mutation.startsAt, timeZone: mutation.timezone },
          end: { dateTime: mutation.endsAt, timeZone: mutation.timezone },
        }),
        { status: 200 },
      );
    }
    if (init.method === 'DELETE') {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected request');
  });

  const request = {
    connection,
    bookingId: mutation.bookingId,
    operationKey: 'operation-cancel-a',
  };
  const first = await provider.cancelBooking(request);
  const replay = await provider.cancelBooking(request);
  assert.deepEqual(replay, first);
  assert.equal(first.cancelled, true);
});

test('Google Calendar provider fails closed on invalid input and provider failures', async () => {
  const invalid = new GoogleCalendarProvider(new MemorySecrets(), 1000, async () => {
    assert.fail('network should not be reached');
  });
  await assert.rejects(
    () =>
      invalid.busy({
        connection,
        startsAt: '2030-01-01T10:00:00',
        endsAt: '2030-01-01T11:00:00Z',
        syncToken: null,
      }),
    CalendarProviderInvalidRequest,
  );

  const unavailable = new GoogleCalendarProvider(
    new MemorySecrets(),
    1000,
    async () => new Response('{}', { status: 401 }),
  );
  await assert.rejects(
    () =>
      unavailable.busy({
        connection,
        startsAt: '2030-01-01T10:00:00Z',
        endsAt: '2030-01-01T11:00:00Z',
        syncToken: null,
      }),
    CalendarProviderUnavailable,
  );
});
