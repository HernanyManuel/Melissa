import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  AITurnClaim,
  AITurnCoordinatorRunner,
  AITurnDispatchStore,
  AITurnProcessor,
} from '../src/ai/ai-turn-processor';
import {
  ConversationTurnRequest,
  ConversationTurnResult,
} from '../src/ai/conversation-turn-coordinator';

const claim = (): AITurnClaim => ({
  id: randomUUID(),
  tenantId: randomUUID(),
  conversationId: randomUUID(),
  customerId: randomUUID(),
  modeEpoch: 7n,
  stateVersion: 12n,
  attempt: 0,
});

class MemoryStore implements AITurnDispatchStore {
  completed = 0;
  rejected = 0;
  failed = 0;
  deferred = 0;
  settled = 0;
  failures = 0;

  constructor(readonly value: AITurnClaim) {}

  claim(id: string, attempt: number) {
    return Promise.resolve(id === this.value.id && attempt === this.value.attempt ? this.value : null);
  }

  complete() {
    this.completed += 1;
    return Promise.resolve();
  }

  reject() {
    this.rejected += 1;
    return Promise.resolve();
  }

  fail() {
    this.failed += 1;
    return Promise.resolve();
  }

  defer() {
    this.deferred += 1;
    return Promise.resolve();
  }

  settleFinished() {
    this.settled += 1;
    return Promise.resolve();
  }

  recordFailure() {
    this.failures += 1;
    return Promise.resolve();
  }
}

const runner = (result: ConversationTurnResult): AITurnCoordinatorRunner => ({
  run: async () => result,
});

const processor = (store: MemoryStore, result: ConversationTurnResult) =>
  new AITurnProcessor(store, runner(result), ['business.info.read'], ['get_business_info']);

test('turn processor builds trusted live request from server-owned claim and policy', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  let request: ConversationTurnRequest | undefined;
  const coordinator: AITurnCoordinatorRunner = {
    run: async (input) => {
      request = input;
      return { status: 'completed', content: 'ok', rounds: 1, toolCalls: 0 };
    },
  };
  const worker = new AITurnProcessor(
    store,
    coordinator,
    ['business.info.read'],
    ['get_business_info'],
  );
  await worker.process(value.id, value.attempt);
  assert.deepEqual(request, {
    tenantId: value.tenantId,
    conversationId: value.conversationId,
    customerId: value.customerId,
    correlationId: value.id,
    turnId: value.id,
    expectedModeEpoch: value.modeEpoch,
    expectedStateVersion: value.stateVersion,
    executionMode: 'live',
    capabilities: ['business.info.read'],
    toolNames: ['get_business_info'],
  });
  assert.equal(store.completed, 1);
});

test('turn processor maps handoff to processed dispatch', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  await processor(store, {
    status: 'handoff_required',
    reason: 'round_limit',
    rounds: 4,
    toolCalls: 2,
  }).process(value.id, 0);
  assert.equal(store.completed, 1);
});

test('turn processor maps stale and failed to terminal dispatch states', async () => {
  const staleValue = claim();
  const staleStore = new MemoryStore(staleValue);
  await processor(staleStore, { status: 'stale' }).process(staleValue.id, 0);
  assert.equal(staleStore.rejected, 1);

  const failedValue = claim();
  const failedStore = new MemoryStore(failedValue);
  await processor(failedStore, { status: 'failed' }).process(failedValue.id, 0);
  assert.equal(failedStore.failed, 1);
});

test('already running turn is deferred without consuming a failure attempt', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  await processor(store, { status: 'skipped', reason: 'already_running' }).process(value.id, 0);
  assert.equal(store.deferred, 1);
  assert.equal(store.failures, 0);
  assert.equal(store.completed, 0);
});

test('already finished turn is settled from durable ledger outcome', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  await processor(store, { status: 'skipped', reason: 'already_finished' }).process(value.id, 0);
  assert.equal(store.settled, 1);
  assert.equal(store.completed, 0);
});

test('coordinator exception records one durable failure and exposes sanitized error', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  const coordinator: AITurnCoordinatorRunner = {
    run: async () => {
      throw new Error('provider secret detail');
    },
  };
  const worker = new AITurnProcessor(store, coordinator, [], []);
  await assert.rejects(() => worker.process(value.id, 0), /AI turn processing failed/);
  assert.equal(store.failures, 1);
});

test('invalid turn job identity fails before store or coordinator', async () => {
  const value = claim();
  const store = new MemoryStore(value);
  let calls = 0;
  store.claim = async () => {
    calls += 1;
    return value;
  };
  const worker = new AITurnProcessor(store, runner({ status: 'failed' }), [], []);
  await assert.rejects(() => worker.process('not-a-uuid', 0), /AI turn processing failed/);
  await assert.rejects(() => worker.process(value.id, 5), /AI turn processing failed/);
  assert.equal(calls, 0);
});
