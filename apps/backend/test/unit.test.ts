import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config';

const base = { DATABASE_URL: 'postgresql://user:secret@localhost:5432/db', REDIS_URL: 'redis://localhost:6379' };
test('accepts development settings with explicit defaults', () => {
  const config = parseConfig(base);
  assert.equal(config.PORT, 3000);
  assert.equal(config.NODE_ENV, 'development');
});
test('rejects invalid ports and protocols without leaking secrets', () => {
  assert.throws(() => parseConfig({ ...base, PORT: '70000' }), /PORT/);
  try {
    parseConfig({ ...base, DATABASE_URL: 'https://user:secret@localhost' });
    assert.fail('configuration should fail');
  } catch (error) {
    assert(error instanceof Error);
    assert(!error.message.includes('secret'));
    assert(error.message.includes('DATABASE_URL'));
  }
});
test('prevents accidental production use before isolation exists', () => {
  assert.throws(() => parseConfig({ ...base, NODE_ENV: 'production' }), /Production is disabled/);
});
