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
import './available-slots-tool.test';
import './get-booking-tool.test';
import './create-booking-tool.test';
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
import './create-lead-tool.test';
import './update-customer-tool.test';
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
      WHATSAPP_QUARANTINE_KEY_ID: 'v1',
      WHATSAPP_QUARANTINE_KEY_BASE64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      WHATSAPP_HTTP_ENABLED: 'true',
    }),
  );
});

test('automatic AI outbound is disabled by default and requires complete secret routing', () => {
  assert.equal(parseConfig(base).AI_OUTBOUND_WORKER_ENABLED, false);
  assert.throws(() => parseConfig({ ...base, AI_OUTBOUND_WORKER_ENABLED: 'true' }));
  assert.throws(() =>
    parseConfig({
      ...base,
      AI_OUTBOUND_WORKER_ENABLED: 'true',
      SECRET_PROVIDER: 'mounted_file',
      SECRET_MOUNT_ROOT: '/run/secrets',
    }),
  );
});

test('AI turn worker is disabled by default and requires an explicit provider', () => {
  assert.equal(parseConfig(base).AI_TURN_WORKER_ENABLED, false);
  assert.throws(() => parseConfig({ ...base, AI_TURN_WORKER_ENABLED: 'true' }));
});

test('accepts development settings with explicit defaults', () => {
  const config = parseConfig(base);
  assert.equal(config.PORT, 3000);
  assert.equal(config.WORKER_PORT, 3001);
  assert.equal(config.LOG_LEVEL, 'info');
});

test('rejects invalid ports and protocols without leaking secrets', () => {
  assert.throws(() => parseConfig({ ...base, PORT: '0' }));
  assert.throws(() => parseConfig({ ...base, DATABASE_URL: 'mysql://user:secret@localhost/db' }));
});

test('prevents accidental production use before isolation exists', () => {
  assert.throws(() => parseConfig({ ...base, NODE_ENV: 'production' }));
});

test('queue connection preserves TLS, credentials and logical database', () => {
  const config = parseConfig({ ...base, REDIS_URL: 'rediss://user:secret@redis.example:6380/2' });
  assert.equal(config.REDIS_URL, 'rediss://user:secret@redis.example:6380/2');
});
