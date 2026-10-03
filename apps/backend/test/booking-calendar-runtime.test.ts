import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDispatchJob } from '../src/calendar/booking-calendar-runtime';

const id = '11111111-1111-4111-8111-111111111111';

test('booking calendar queue accepts only the opaque dispatch route', () => {
  assert.equal(isDispatchJob('booking-calendar-dispatch', { id, attempt: 0 }), true);
  assert.equal(isDispatchJob('booking-calendar-dispatch', { id, attempt: 4 }), true);
});

test('booking calendar queue rejects identity, credential, and extra fields', () => {
  for (const data of [
    { id, attempt: 0, tenantId: '22222222-2222-4222-8222-222222222222' },
    { id, attempt: 0, credentialRef: 'secret/ref' },
    { id, attempt: 0, accessToken: 'secret-token' },
    { id, attempt: 0, bookingId: '33333333-3333-4333-8333-333333333333' },
  ]) {
    assert.equal(isDispatchJob('booking-calendar-dispatch', data), false);
  }
});

test('booking calendar queue rejects malformed routes', () => {
  assert.equal(isDispatchJob('wrong-name', { id, attempt: 0 }), false);
  assert.equal(isDispatchJob('booking-calendar-dispatch', { id: 'not-a-uuid', attempt: 0 }), false);
  assert.equal(isDispatchJob('booking-calendar-dispatch', { id, attempt: -1 }), false);
  assert.equal(isDispatchJob('booking-calendar-dispatch', { id, attempt: 5 }), false);
  assert.equal(isDispatchJob('booking-calendar-dispatch', { id, attempt: 1.5 }), false);
  assert.equal(isDispatchJob('booking-calendar-dispatch', null), false);
});
