import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  HumanOutboundClaim,
  HumanOutboundDispatcher,
  HumanOutboundStore,
} from '../src/messaging/human-outbound-dispatcher';
import { MessagingDeliveryUnknown, MessagingProvider } from '../src/channels/messaging-provider';
import { MessagingProviderRegistry } from '../src/channels/messaging-provider-registry';

type RejectReason = 'stale' | 'unauthorized';
type LeaseWork = (assertOwned: () => Promise<void>) => Promise<void>;

const claim = (): HumanOutboundClaim => ({
  id: randomUUID(),
  tenantId: randomUUID(),
  actorId: randomUUID(),
  conversationId: randomUUID(),
  modeEpoch: 4n,
  attempt: 0,
  recipientReference: '+351910000000',
  senderReference: '123456789012345',
  credentialsReference: 'secret://tenant/channel/whatsapp',
  text: 'Resposta humana',
  channel: { mode: 'live', channelType: 'whatsapp', status: 'active' },
});

class MemoryStore implements HumanOutboundStore {
  current = true;
  accepted = 0;
  rejected: RejectReason[] = [];
  failures = 0;
  unknown = 0;

  constructor(readonly value: HumanOutboundClaim) {}

  claim(id: string, attempt: number) {
    return Promise.resolve(
      id === this.value.id && attempt === this.value.attempt ? this.value : null,
    );
  }
  isCurrent() {
    return Promise.resolve(this.current);
  }
  reject(_claim: HumanOutboundClaim, reason: RejectReason) {
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
    this.unknown += 1;
    return Promise.resolve();
  }
}

const lease = async (_key: string, work: LeaseWork) => {
  await work(async () => undefined);
  return true;
};

const registry = (provider?: MessagingProvider) =>
  new MessagingProviderRegistry(provider ? [provider] : []);

test('human outbound rechecks conversation fencing before provider send', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  let checks = 0;
  store.isCurrent = () => Promise.resolve(++checks === 1);
  let sends = 0;
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async () => {
      sends += 1;
      return { providerMessageId: 'wamid.1', acceptedAt: new Date() };
    },
  };
  const dispatcher = new HumanOutboundDispatcher(store, registry(provider), undefined, lease);
  await dispatcher.process(value.id, 0);
  assert.equal(sends, 0);
  assert.deepEqual(store.rejected, ['stale']);
  assert.equal(store.accepted, 0);
});

test('human outbound persists a valid provider receipt', async () => {
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
      return { providerMessageId: 'wamid.2', acceptedAt: new Date() };
    },
  };
  const dispatcher = new HumanOutboundDispatcher(store, registry(provider), undefined, lease);
  await dispatcher.process(value.id, 0);
  assert.equal(store.accepted, 1);
  assert.equal(store.failures, 0);
  assert.equal(store.unknown, 0);
});

test('human outbound treats ambiguous provider delivery as terminal', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async () => {
      throw new MessagingDeliveryUnknown();
    },
  };
  const dispatcher = new HumanOutboundDispatcher(store, registry(provider), undefined, lease);
  await assert.rejects(() => dispatcher.process(value.id, 0), /Human outbound processing failed/);
  assert.equal(store.failures, 0);
  assert.equal(store.unknown, 1);
});

test('human outbound never retries provider after a successful send if persistence fails', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  store.accept = () => Promise.reject(new Error('database unavailable'));
  let sends = 0;
  const provider: MessagingProvider = {
    key: 'whatsapp:live',
    sendText: async () => {
      sends += 1;
      return { providerMessageId: 'wamid.3', acceptedAt: new Date() };
    },
  };
  const dispatcher = new HumanOutboundDispatcher(store, registry(provider), undefined, lease);
  await assert.rejects(() => dispatcher.process(value.id, 0), /Human outbound processing failed/);
  assert.equal(sends, 1);
  assert.equal(store.failures, 0);
  assert.equal(store.unknown, 1);
});
