import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessagingProvider } from '../src/channels/messaging-provider';
import { MessagingProviderRegistry } from '../src/channels/messaging-provider-registry';
import {
  AIAutomaticOutboundClaim,
  AIAutomaticOutboundDispatcher,
  AIAutomaticOutboundStore,
} from '../src/ai/ai-outbound-dispatcher';

const claim = (): AIAutomaticOutboundClaim => ({
  id: randomUUID(),
  tenantId: randomUUID(),
  conversationId: randomUUID(),
  customerId: randomUUID(),
  modeEpoch: 3n,
  attempt: 0,
  recipientReference: '+351910000000',
  text: 'Olá',
  channel: { mode: 'live', channelType: 'whatsapp', status: 'active' },
});

class MemoryStore implements AIAutomaticOutboundStore {
  current = true;
  accepted = 0;
  rejected: string[] = [];
  failures = 0;
  constructor(readonly value: AIAutomaticOutboundClaim) {}
  claim(id: string, attempt: number) {
    return Promise.resolve(id === this.value.id && attempt === this.value.attempt ? this.value : null);
  }
  isCurrent() {
    return Promise.resolve(this.current);
  }
  reject(_claim: AIAutomaticOutboundClaim, reason: 'stale' | 'unauthorized') {
    this.rejected.push(reason);
    return Promise.resolve();
  }
  accept() {
    this.accepted += 1;
    return Promise.resolve();
  }
  recordFailure() {
    this.failures += 1;
    return Promise.resolve();
  }
}

const lease = async (
  _key: string,
  work: (assertOwned: () => Promise<void>) => Promise<void>,
) => {
  await work(async () => undefined);
  return true;
};

test('automatic outbound rechecks fencing immediately before provider effect', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  let checks = 0;
  store.isCurrent = () => Promise.resolve(++checks === 1);
  let sends = 0;
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async () => {
      sends += 1;
      return { providerMessageId: 'provider-1', acceptedAt: new Date() };
    },
  };
  const dispatcher = new AIAutomaticOutboundDispatcher(
    store,
    new MessagingProviderRegistry([provider]),
    undefined,
    lease,
  );
  await dispatcher.process(value.id, 0);
  assert.equal(sends, 0);
  assert.deepEqual(store.rejected, ['stale']);
  assert.equal(store.accepted, 0);
});

test('automatic outbound accepts only after a valid provider receipt', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async (input) => {
      assert.equal(input.attemptId, value.id);
      assert.equal(input.recipientReference, value.recipientReference);
      assert.equal(input.text, value.text);
      return { providerMessageId: 'provider-2', acceptedAt: new Date() };
    },
  };
  const dispatcher = new AIAutomaticOutboundDispatcher(
    store,
    new MessagingProviderRegistry([provider]),
    undefined,
    lease,
  );
  await dispatcher.process(value.id, 0);
  assert.equal(store.accepted, 1);
  assert.equal(store.failures, 0);
});

test('automatic outbound fails closed without a live provider', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const dispatcher = new AIAutomaticOutboundDispatcher(
    store,
    new MessagingProviderRegistry([]),
    undefined,
    lease,
  );
  await assert.rejects(() => dispatcher.process(value.id, 0), /Automatic outbound processing failed/);
  assert.equal(store.accepted, 0);
  assert.equal(store.failures, 1);
});
