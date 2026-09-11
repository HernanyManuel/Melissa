import 'reflect-metadata';
import './whatsapp-inbound.test';
import './quarantine-policy.test';
import './receipt-state.test';
import './messaging-provider.test';
import './whatsapp-cloud-messaging-provider.test';
import './storage-provider.test';
import './media-ingestor.test';
import './whatsapp-media-source.test';
import './whatsapp-media-config.test';
import './quarantine-keyring.test';
import './s3-storage-provider.test';
import './media-ingestion-queue.test';
import './malware-scanner.test';
import './mounted-file-secret-resolver.test';
import './ai-gateway.test';
import './openai-responses-provider.test';
import './tool-executor.test';
import './business-read-tools.test';
import './ai-context-builder.test';
import './conversation-state.test';
import './conversation-engine.test';
import './ai-turn-ledger.test';
import './conversation-turn-coordinator.test';
import './ai-turn-queue.test';
import './ai-turn-processor.test';
import './ai-turn-runtime.test';
import './ai-outbound-dispatcher.test';
import './ai-outbound-queue.test';
import './ai-outbound-runtime.test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config';
import { allows } from '../src/tenancy/permissions';
import { batchDeadline } from '../src/messaging/batching';

test('debounce extends quiet window but never exceeds five seconds', () => {
  const start = new Date('2026-09-03T00:00:00Z');
  assert.equal(batchDeadline(start, start, 1500).getTime(), start.getTime() + 1500);
  assert.equal(
    batchDeadline(start, new Date(start.getTime() + 4500), 1500).getTime(),
    start.getTime() + 5000,
  );
});

test('only owners and admins manage channels', () => {
  assert(allows('owner', 'channels:manage'));
  assert(allows('admin', 'channels:manage'));
  for (const role of ['manager', 'staff', 'viewer'] as const)
    assert(!allows(role, 'channels:manage'));
});

test('conversation access excludes viewers', () => {
  for (const role of ['owner', 'admin', 'manager', 'staff'] as const)
    assert(allows(role, 'messages:read'));
  assert(!allows('viewer', 'messages:read'));
});

test('customer permissions grant least privilege by role', () => {
  for (const role of ['owner', 'admin', 'manager'] as const) {
    assert(allows(role, 'customers:read'));
    assert(allows(role, 'customers:write'));
  }
  assert(allows('staff', 'customers:read'));
  assert(!allows('staff', 'customers:write'));
  assert(!allows('viewer', 'customers:read'));
  assert(!allows('viewer', 'customers:write'));
});

const base = {
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};
test('WhatsApp HTTP is opt-in and requires complete server configuration', () => {
  assert.throws(() => parseConfig({ ...base, WHATSAPP_QUARANTINE_KEY_ID: 'v1' }));
  assert.throws(() =>
    parseConfig({
      ...base,
      WHATSAPP_QUARANTINE_KEY: 'not-a-key',
      WHATSAPP_QUARANTINE_KEY_ID: 'v1',
    }),
  );
  assert.equal(
    parseConfig({
      ...base,
      WHATSAPP_QUARANTINE_KEY_ID: 'v1',
      WHATSAPP_QUARANTINE_KEY: Buffer.alloc(32, 7).toString('base64'),
    }).WHATSAPP_QUARANTINE_KEY_ID,
    'v1',
  );
  assert.equal(parseConfig(base).WHATSAPP_WEBHOOK_ENABLED, 'false');
  assert.throws(
    () => parseConfig({ ...base, WHATSAPP_WEBHOOK_ENABLED: 'true' }),
    /requires server-side/,
  );
  assert.throws(() => parseConfig({ ...base, WHATSAPP_WEBHOOK_ENABLED: 'yes' }));
  assert.equal(
    parseConfig({
      ...base,
      WHATSAPP_WEBHOOK_ENABLED: 'true',
      WHATSAPP_INTEGRATION_KEY: 'test_app',
      WHATSAPP_APP_SECRET: 'synthetic-test-secret',
      WHATSAPP_VERIFY_TOKEN: 'synthetic-test-token',
    }).WHATSAPP_WEBHOOK_ENABLED,
    'true',
  );
});

test('automatic AI outbound is disabled by default and requires complete secret routing', () => {
  const config = parseConfig(base);
  assert.equal(config.AI_OUTBOUND_WORKER_ENABLED, 'false');
  assert.equal(config.SECRET_PROVIDER, 'disabled');
  assert.throws(() => parseConfig({ ...base, AI_OUTBOUND_WORKER_ENABLED: 'true' }));
  assert.throws(() =>
    parseConfig({
      ...base,
      SECRET_PROVIDER: 'mounted-file',
      SECRET_MOUNT_DIRECTORY: '/run/secrets/melissa',
      WHATSAPP_MESSAGING_API_VERSION: 'v23.0',
    }),
  );
  const enabled = parseConfig({
    ...base,
    SECRET_PROVIDER: 'mounted-file',
    SECRET_MOUNT_DIRECTORY: '/run/secrets/melissa',
    AI_OUTBOUND_WORKER_ENABLED: 'true',
    WHATSAPP_MESSAGING_API_VERSION: 'v23.0',
  });
  assert.equal(enabled.AI_OUTBOUND_WORKER_ENABLED, 'true');
  assert.equal(enabled.SECRET_PROVIDER, 'mounted-file');
});

test('AI turn worker is disabled by default and requires an explicit provider', () => {
  assert.equal(parseConfig(base).AI_TURN_WORKER_ENABLED, 'false');
  assert.throws(() => parseConfig({ ...base, AI_TURN_WORKER_ENABLED: 'true' }), /explicit AI provider/);
  const enabled = parseConfig({
    ...base,
    AI_TURN_WORKER_ENABLED: 'true',
    AI_PROVIDER: 'mock',
  });
  assert.equal(enabled.AI_TURN_WORKER_ENABLED, 'true');
  assert.equal(enabled.AI_PROVIDER, 'mock');
});

test('accepts development settings with explicit defaults', () => {
  const config = parseConfig(base);
  assert.equal(config.PORT, 3000);
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.MESSAGE_DEBOUNCE_MS, 1500);
  assert.throws(() => parseConfig({ ...base, MESSAGE_DEBOUNCE_MS: 2001 }));
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

test('queue connection preserves TLS, credentials and logical database', async () => {
  const { queueConnection } = await import('../src/queue-connection');
  assert.deepEqual(queueConnection('rediss://worker:p%40ss@redis.example:6380/2'), {
    host: 'redis.example',
    port: 6380,
    username: 'worker',
    password: 'p@ss',
    db: 2,
    maxRetriesPerRequest: null,
    tls: {},
  });
  assert.throws(() => queueConnection('redis://localhost/not-a-db'), /Invalid Redis/);
  assert.throws(() => queueConnection('https://localhost'), /Invalid Redis/);
});
