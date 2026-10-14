import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchRetrySeconds } from '../src/billing/stripe-test-dispatcher';

test('Stripe dispatch retry backoff stays bounded', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((n) => dispatchRetrySeconds(n)),
    [30, 120, 480, 1800, 1800, 1800],
  );
  for (const bad of [0, -1, 7, 1.25, NaN]) {
    assert.throws(() => dispatchRetrySeconds(bad));
  }
});
