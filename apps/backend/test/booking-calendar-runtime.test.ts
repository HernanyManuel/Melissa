import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDispatchJob, startSerialLoop } from '../src/calendar/booking-calendar-runtime';

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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('serial calendar loop never overlaps reconciliation cycles', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const loop = startSerialLoop(
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs += 1;
      await delay(15);
      active -= 1;
    },
    1,
    () => undefined,
  );
  await delay(50);
  await loop.stop();
  assert(runs >= 2);
  assert.equal(maxActive, 1);
});

test('serial calendar loop shutdown waits for the active reconciliation cycle', async () => {
  let release: (() => void) | undefined;
  let completed = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loop = startSerialLoop(
    async () => {
      await blocked;
      completed = true;
    },
    1,
    () => undefined,
  );
  await delay(5);
  let stopped = false;
  const stopping = loop.stop().then(() => {
    stopped = true;
  });
  await delay(5);
  assert.equal(stopped, false);
  release?.();
  await stopping;
  assert.equal(completed, true);
  assert.equal(stopped, true);
});
