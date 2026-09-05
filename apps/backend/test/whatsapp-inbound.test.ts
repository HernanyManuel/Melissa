import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WhatsAppInboundProvider } from '../src/channels/whatsapp-inbound';

const secret = 'synthetic-unit-test-secret';
const provider = new WhatsAppInboundProvider(secret, 'synthetic-verify-token');
const sign = (body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const text = {
  id: 'wamid.test',
  from: '351900000001',
  timestamp: '1788390000',
  type: 'text',
  text: { body: 'Olá 👋' },
};
const payload = (messages: unknown[] = [text]) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '456' },
            messages,
          },
        },
      ],
    },
  ],
});
const decode = (body: unknown) => {
  const raw = Buffer.from(JSON.stringify(body));
  return provider.decode(raw, sign(raw));
};

test('WhatsApp normalizes every entry and message without trusting tenant metadata', () => {
  const body = payload([text, { ...text, id: 'second' }]);
  body.entry.push({ ...body.entry[0]!, id: '789' });
  const result = decode({ ...body, tenant_id: 'attacker' });
  assert.equal(result.events.length, 4);
  assert.equal(result.unsupported, 0);
  assert.deepEqual(result.events[0], {
    kind: 'text',
    provider: 'whatsapp',
    accountId: '123',
    phoneId: '456',
    messageId: 'wamid.test',
    senderId: '351900000001',
    timestamp: '1788390000',
    text: 'Olá 👋',
  });
  assert.equal(result.events[2]!.accountId, '789');
});

test('WhatsApp signature covers exact original bytes, before JSON parsing', () => {
  const raw = Buffer.from(JSON.stringify(payload(), null, 2));
  assert.equal(provider.decode(raw, sign(raw)).events.length, 1);
  const compact = Buffer.from(JSON.stringify(payload()));
  assert.throws(() => provider.decode(compact, sign(raw)), /signature/);
  for (const signature of [undefined, [], 'sha1=123', 'sha256=xx', `sha256=${'0'.repeat(64)}`])
    assert.throws(() => provider.decode(raw, signature), /signature/);
  const invalid = Buffer.from('{ invalid sensitive payload');
  assert.throws(
    () => provider.decode(invalid, sign(invalid)),
    /^Error: WhatsApp webhook: payload$/,
  );
  assert.throws(() => provider.decode(invalid, ''), /signature/);
  assert.throws(() => provider.decode(Buffer.alloc(256 * 1024 + 1), ''), /size/);
});

test('WhatsApp setup verifies token, mode and scalar challenge', () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'synthetic-verify-token',
    'hub.challenge': '12345',
  };
  assert.equal(provider.verifyChallenge(query), '12345');
  for (const bad of [
    { 'hub.verify_token': 'wrong' },
    { 'hub.verify_token': ['synthetic-verify-token'] },
    { 'hub.mode': 'other' },
    { 'hub.challenge': '<script>' },
  ])
    assert.throws(() => provider.verifyChallenge({ ...query, ...bad }), /verification/);
  assert.throws(() => new WhatsAppInboundProvider('', ''), /configuration/);
});

test('WhatsApp reports unsupported events and normalizes delivery statuses separately', () => {
  const value = {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: '456' },
    messages: [{ ...text, type: 'image', text: undefined }],
    statuses: ['sent', 'delivered', 'read', 'failed', 'future'].map((status) => ({
      id: 'wamid.out',
      recipient_id: '351900000001',
      timestamp: '1788390000',
      status,
    })),
  };
  const result = decode({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123',
        changes: [
          { field: 'messages', value },
          { field: 'account_update', value: {} },
        ],
      },
    ],
  });
  assert.equal(result.events.length, 4);
  assert(result.events.every((event) => event.kind === 'status'));
  assert.equal(result.unsupported, 3);
});

test('WhatsApp rejects malformed and oversized batches atomically', () => {
  assert.throws(() => decode(payload([text, { ...text, text: undefined }])), /payload/);
  assert.throws(() => decode(payload(Array.from({ length: 101 }, () => text))), /payload/);
  assert.throws(() => decode(payload([{ ...text, timestamp: '-1' }])), /payload/);
  assert.throws(() => decode({ ...payload(), object: 'other' }), /payload/);
  const invalidUtf8 = Buffer.from([0xff, 0xfe]);
  assert.throws(() => provider.decode(invalidUtf8, sign(invalidUtf8)), /payload/);
});
