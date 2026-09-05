import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockMessagingProvider } from '../src/channels/mock-messaging-provider';
import { MessagingProviderRegistry } from '../src/channels/messaging-provider-registry';
import {
  MessagingProviderUnavailable,
  ProviderPayloadConflict,
} from '../src/channels/messaging-provider';

const input = {
  attemptId: '1d33c68e-a5b9-4fef-8d76-9e861b682cbe',
  recipientReference: 'synthetic-recipient',
  text: 'synthetic outbound text',
};

test('mock provider is deterministic and idempotent under concurrent retry', async () => {
  const provider = new MockMessagingProvider();
  const deliveries = await Promise.all(Array.from({ length: 20 }, () => provider.sendText(input)));
  assert.equal(new Set(deliveries.map((item) => item.providerMessageId)).size, 1);
  assert.equal(deliveries[0]!.providerMessageId, `mock:${input.attemptId}`);
  assert(deliveries.every((item) => item.acceptedAt === deliveries[0]!.acceptedAt));
  await assert.rejects(
    provider.sendText({ ...input, text: 'changed payload' }),
    ProviderPayloadConflict,
  );
});

test('registry never falls back from live, disconnected or unknown channels to mock', () => {
  const mock = new MockMessagingProvider();
  const registry = new MessagingProviderRegistry([mock]);
  assert.equal(registry.resolve({ mode: 'mock', channelType: 'whatsapp', status: 'active' }), mock);
  for (const channel of [
    { mode: 'live', channelType: 'whatsapp', status: 'active' },
    { mode: 'mock', channelType: 'whatsapp', status: 'disconnected' },
    { mode: 'mock', channelType: 'sms', status: 'active' },
  ])
    assert.throws(() => registry.resolve(channel), MessagingProviderUnavailable);
  assert.throws(() => new MessagingProviderRegistry([mock, mock]), /Duplicate/);
});
