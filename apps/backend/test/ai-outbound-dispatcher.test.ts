import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  AIAutomaticOutboundClaim,
  AIAutomaticOutboundDispatcher,
  AIAutomaticOutboundStore,
} from '../src/ai/ai-outbound-dispatcher';
import {
  MessagingDeliveryUnknown,
  MessagingProvider,
} from '../src/channels/messaging-provider';
import { MessagingProviderRegistry } from '../src/channels/messaging-provider-registry';

type RejectReason = 'stale' | 'unauthorized';
type AssertOwned = () => Promise<void>;
type LeaseWork = (assertOwned: AssertOwned) => Promise<void>;

const claim = (): AIAutomaticOutboundClaim => ({
  id: randomUUID(),
  tenantId: randomUUID(),
  conversationId: randomUUID(),
  customerId: randomUUID(),
  modeEpoch: 3n,
  attempt: 0,
  recipientReference: '+351910000000',
  senderReference: '123456789012345',
  credentialsReference: 'secret://tenant/channel/whatsapp',
  text: 'Olá',
  channel: {
    mode: 'live',
    channelType: 'whatsapp',
    status: 'active',
  },
});

class MemoryStore implements AIAutomaticOutboundStore {
  current = true;
  accepted = 0;
  rejected: RejectReason[] = [];
  failures = 0;
  unknownDeliveries = 0;

  constructor(readonly value: AIAutomaticOutboundClaim) {}

  claim(id: string, attempt: number) {
    if (id !== this.value.id) return Promise.resolve(null);
    if (attempt !== this.value.attempt) return Promise.resolve(null);
    return Promise.resolve(this.value);
  }

  isCurrent() {
    return Promise.resolve(this.current);
  }

  reject(_claim: AIAutomaticOutboundClaim, reason: RejectReason) {
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

  recordUnknownDelivery() {
    this.unknownDeliveries += 1;
    return Promise.resolve();
  }
}

const lease = async (_key: string, work: LeaseWork) => {
  await work(async () => undefined);
  return true;
};

const registry = (provider?: MessagingProvider) => {
  return new MessagingProviderRegistry(provider ? [provider] : []);
};

test('automatic outbound rechecks fencing before provider effect', async () => {
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
  const dispatcher = new AIAutomaticOutboundDispatcher(store, registry(provider), undefined, lease);
  await dispatcher.process(value.id, 0);
  assert.equal(sends, 0);
  assert.deepEqual(store.rejected, ['stale']);
  assert.equal(store.accepted, 0);
});

test('automatic outbound accepts only after valid receipt', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async (input) => {
      assert.equal(input.attemptId, value.id);
      assert.equal(input.recipientReference, value.recipientReference);
      assert.equal(input.senderReference, value.senderReference);
      assert.equal(input.credentialsReference, value.credentialsReference);
      assert.equal(input.text, value.text);
      return { providerMessageId: 'provider-2', acceptedAt: new Date() };
    },
  };
  const dispatcher = new AIAutomaticOutboundDispatcher(store, registry(provider), undefined, lease);
  await dispatcher.process(value.id, 0);
  assert.equal(store.accepted, 1);
  assert.equal(store.failures, 0);
});

test('automatic outbound fails closed without live provider', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const dispatcher = new AIAutomaticOutboundDispatcher(store, registry(), undefined, lease);
  const run = () => dispatcher.process(value.id, 0);
  await assert.rejects(run, /Automatic outbound processing failed/);
  assert.equal(store.accepted, 0);
  assert.equal(store.failures, 1);
});

test('ambiguous live delivery is terminal instead of automatically retried', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async () => {
      throw new MessagingDeliveryUnknown();
    },
  };
  const dispatcher = new AIAutomaticOutboundDispatcher(store, registry(provider), undefined, lease);
  await assert.rejects(
    () => dispatcher.process(value.id, 0),
    /Automatic outbound processing failed/,
  );
  assert.equal(store.failures, 0);
  assert.equal(store.unknownDeliveries, 1);
}
);
