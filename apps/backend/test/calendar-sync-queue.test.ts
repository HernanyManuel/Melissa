import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCalendarSyncJob } from '../src/calendar/calendar-sync-queue';

function validJob(): Record<string, unknown> {
  return {
    tenantId: '9bbf7a7b-7b22-4e2d-b504-26c60d1adf4d',
    connectionId: 'a07611a0-437e-4f43-bf9a-18b97033e3b8',
    startsAt: '2026-09-12T00:00:00Z',
    endsAt: '2026-10-12T00:00:00Z',
  };
}

test('calendar sync queue accepts only bounded tenant-scoped jobs', () => {
  assert(isCalendarSyncJob('calendar-sync-busy', validJob()));
  assert(!isCalendarSyncJob('other', validJob()));
  assert(!isCalendarSyncJob('calendar-sync-busy', { ...validJob(), tenantId: 'not-a-uuid' }));
  assert(
    !isCalendarSyncJob('calendar-sync-busy', {
      ...validJob(),
      startsAt: '2026-09-12T00:00:00',
    }),
  );
  assert(
    !isCalendarSyncJob('calendar-sync-busy', {
      ...validJob(),
      endsAt: '2026-09-12T00:00:00Z',
    }),
  );
  assert(
    !isCalendarSyncJob('calendar-sync-busy', {
      ...validJob(),
      endsAt: '2028-01-01T00:00:00Z',
    }),
  );
  assert(!isCalendarSyncJob('calendar-sync-busy', { ...validJob(), unexpected: true }));
});
