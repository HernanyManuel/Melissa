import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { checkedReceiptState } from '../src/messaging/receipt-state';

test('receipt success requires processed dispatch, message and processed timestamp', () => {
  assert.equal(checkedReceiptState('processed', true, new Date()), 'processed');
  for (const [state, hasMessage, processedAt] of [
    [undefined, false, null],
    [undefined, true, new Date()],
    ['processed', false, new Date()],
    ['processed', true, null],
    ['unknown', false, null],
    ['pending', true, new Date()],
    ['failed', true, new Date()],
    ['rejected', true, new Date()],
  ] as const) {
    assert.throws(
      () => checkedReceiptState(state, hasMessage, processedAt),
      ServiceUnavailableException,
    );
  }
});
test('non-success receipts retain their real state', () => {
  for (const state of ['pending', 'failed', 'rejected']) {
    assert.equal(checkedReceiptState(state, false, null), state);
  }
});
