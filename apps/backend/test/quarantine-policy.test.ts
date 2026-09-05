import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quarantineNotices } from '../src/channels/quarantine-policy';

test('quarantine notices cover exact capacity thresholds without duplicates', () => {
  for (const total of [0, 1, 799]) assert.deepEqual(quarantineNotices(total, 0, 0), []);
  for (const total of [800, 999])
    assert.deepEqual(quarantineNotices(total, 0, 0), ['capacity_warning']);
  for (const total of [1000, 1001])
    assert.deepEqual(quarantineNotices(total, 0, 0), ['capacity_full']);
});

test('expiry notices coexist and disappear when observations recover', () => {
  assert.deepEqual(quarantineNotices(1000, 2, 3), [
    'capacity_full',
    'cleanup_pending',
    'expiring_soon',
  ]);
  assert.deepEqual(quarantineNotices(5, 0, 5), ['expiring_soon']);
  assert.deepEqual(quarantineNotices(5, 5, 0), ['cleanup_pending']);
  assert.deepEqual(quarantineNotices(0, 0, 0), []);
});
