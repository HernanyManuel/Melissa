import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, whatsappMediaHosts } from '../src/config';
import { createWhatsAppMediaSource } from '../src/storage/whatsapp-media-factory';

const base = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};
const enabled = {
  ...base,
  WHATSAPP_MEDIA_ENABLED: 'true',
  WHATSAPP_MEDIA_ACCESS_TOKEN: 'synthetic-test-token-never-real',
  WHATSAPP_MEDIA_API_VERSION: 'v23.0',
  WHATSAPP_MEDIA_DOWNLOAD_HOSTS: 'media-a.example.test,media-b.example.test',
};

test('WhatsApp media is disabled by default and has no mock fallback', () => {
  const config = parseConfig(base);
  assert.equal(config.WHATSAPP_MEDIA_ENABLED, 'false');
  assert.equal(createWhatsAppMediaSource(config), null);
});

test('complete explicit WhatsApp media configuration creates the real adapter without I/O', () => {
  const config = parseConfig(enabled);
  assert.equal(createWhatsAppMediaSource(config)?.providerKey, 'whatsapp');
  assert.deepEqual(whatsappMediaHosts(config.WHATSAPP_MEDIA_DOWNLOAD_HOSTS), [
    'media-a.example.test',
    'media-b.example.test',
  ]);
  assert.deepEqual(whatsappMediaHosts('same.example.test,same.example.test'), [
    'same.example.test',
  ]);
});

test('enabled media fails startup with incomplete or unsafe configuration', () => {
  for (const removed of [
    'WHATSAPP_MEDIA_ACCESS_TOKEN',
    'WHATSAPP_MEDIA_API_VERSION',
    'WHATSAPP_MEDIA_DOWNLOAD_HOSTS',
  ] as const) {
    const input: Record<string, unknown> = { ...enabled };
    delete input[removed];
    assert.throws(() => parseConfig(input), /WhatsApp media requires/);
  }
  for (const hosts of [
    'localhost',
    '*.example.test',
    'https://media.example.test',
    'media.example.test,',
    'MEDIA.example.test',
    'media.example.test, other.example.test',
  ])
    assert.throws(
      () => parseConfig({ ...enabled, WHATSAPP_MEDIA_DOWNLOAD_HOSTS: hosts }),
      /WHATSAPP_MEDIA_DOWNLOAD_HOSTS/,
    );
  assert.throws(
    () => parseConfig({ ...enabled, WHATSAPP_MEDIA_ACCESS_TOKEN: ' short-secret-value ' }),
    /WhatsApp media requires/,
  );
  assert.throws(
    () => parseConfig({ ...enabled, WHATSAPP_MEDIA_API_VERSION: 'latest' }),
    /WHATSAPP_MEDIA_API_VERSION/,
  );
});
