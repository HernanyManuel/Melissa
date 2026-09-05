import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, whatsappPreviousQuarantineKeys } from '../src/config';
import { createQuarantineKeyring } from '../src/channels/quarantine-keyring';

const base = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};
const encoded = (byte: number) => Buffer.alloc(32, byte).toString('base64');

test('quarantine keyring writes with current key and resolves bounded previous keys', () => {
  const config = parseConfig({
    ...base,
    WHATSAPP_QUARANTINE_KEY_ID: 'current-v3',
    WHATSAPP_QUARANTINE_KEY: encoded(3),
    WHATSAPP_QUARANTINE_PREVIOUS_KEYS: `previous-v2=${encoded(2)},previous-v1=${encoded(1)}`,
  });
  const keyring = createQuarantineKeyring(config);
  assert.equal(keyring.current?.id, 'current-v3');
  assert.deepEqual(keyring.current?.key, Buffer.alloc(32, 3));
  const previous = keyring.resolve('previous-v2');
  assert.deepEqual(previous, Buffer.alloc(32, 2));
  previous![0] = 99;
  assert.deepEqual(keyring.resolve('previous-v2'), Buffer.alloc(32, 2));
  assert.equal(keyring.resolve('unknown'), null);
});

test('quarantine keyring rejects ambiguous, malformed and unbounded rotation sets', () => {
  const current = {
    ...base,
    WHATSAPP_QUARANTINE_KEY_ID: 'current',
    WHATSAPP_QUARANTINE_KEY: encoded(9),
  };
  for (const previous of [
    `current=${encoded(1)}`,
    `old=${encoded(9)}`,
    `old=${encoded(1)},other=${encoded(1)}`,
    `old=${encoded(1)},old=${encoded(2)}`,
  ])
    assert.throws(() => parseConfig({ ...current, WHATSAPP_QUARANTINE_PREVIOUS_KEYS: previous }));
  for (const previous of [
    'missing-separator',
    'bad id=' + encoded(1),
    'old=not-base64',
    `old=${encoded(1)}, second=${encoded(2)}`,
  ])
    assert.throws(() => whatsappPreviousQuarantineKeys(previous));
  assert.throws(() =>
    parseConfig({
      ...current,
      WHATSAPP_QUARANTINE_PREVIOUS_KEYS: [1, 2, 3, 4, 5]
        .map((value) => `v${value}=${encoded(value)}`)
        .join(','),
    }),
  );
  assert.throws(() =>
    parseConfig({
      ...base,
      WHATSAPP_QUARANTINE_PREVIOUS_KEYS: `old=${encoded(1)}`,
    }),
  );
});

test('empty keyring remains disabled and never invents a key', () => {
  const keyring = createQuarantineKeyring(parseConfig(base));
  assert.equal(keyring.current, undefined);
  assert.equal(keyring.resolve('anything'), null);
});
