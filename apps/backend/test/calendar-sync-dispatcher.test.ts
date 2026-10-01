import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarSyncWindow } from '../src/calendar/calendar-sync-dispatcher';

test('calendar sync dispatcher uses a bounded deterministic coverage window', () => {
  const window = calendarSyncWindow(new Date('2037-09-15T12:03:41Z'));
  assert.deepEqual(window, {
    startsAt: '2037-09-14T12:00:00.000Z',
    endsAt: '2037-12-14T12:00:00.000Z',
  });
});

test('calendar sync dispatcher rejects an invalid clock', () => {
  assert.throws(() => calendarSyncWindow(new Date(Number.NaN)), /Invalid calendar sync clock/);
});
