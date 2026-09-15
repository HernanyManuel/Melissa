import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversationStateRepository,
  ConversationStateService,
  ConversationStateV1,
  StaleConversationState,
  validateConversationState,
} from '../src/ai/conversation-state';

const ids = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
};
const state: ConversationStateV1 = {
  version: 1,
  intent: 'booking',
  stage: 'collecting_service',
  serviceId: null,
  date: null,
  staffId: null,
};

function repository(commitResult = true, modeResult = true): ConversationStateRepository {
  return {
    load: async () => ({ mode: 'AI_ACTIVE', modeEpoch: 2n, stateVersion: 3n, state }),
    commit: async () => commitResult,
    changeMode: async () => modeResult,
  };
}

test('conversation state validator accepts only the exact versioned shape', () => {
  assert.deepEqual(validateConversationState(state), state);
  for (const invalid of [
    {},
    { ...state, version: 2 },
    { ...state, unexpected: true },
    { ...state, stage: 'admin' },
    { ...state, serviceId: 'not-a-uuid' },
    { ...state, date: '2026-02-31' },
    JSON.parse(
      '{"version":1,"intent":null,"stage":"idle","serviceId":null,"date":null,"staffId":null,"__proto__":{}}',
    ),
  ])
    assert.throws(() => validateConversationState(invalid), StaleConversationState);
});

test('state commit propagates tenant scope and optimistic fencing versions', async () => {
  let captured: unknown;
  const repo = repository();
  repo.commit = async (input) => {
    captured = input;
    return true;
  };
  await new ConversationStateService(repo).commit({
    ...ids,
    expectedModeEpoch: 2n,
    expectedStateVersion: 3n,
    state,
  });
  assert.deepEqual(captured, {
    ...ids,
    expectedModeEpoch: 2n,
    expectedStateVersion: 3n,
    state,
  });
});

test('stale state and stale mode transitions fail closed', async () => {
  await assert.rejects(
    new ConversationStateService(repository(false)).commit({
      ...ids,
      expectedModeEpoch: 2n,
      expectedStateVersion: 3n,
      state,
    }),
    StaleConversationState,
  );
  await assert.rejects(
    new ConversationStateService(repository(true, false)).changeMode(
      ids.tenantId,
      ids.conversationId,
      2n,
      'AI_ACTIVE',
      'WAITING_HUMAN',
    ),
    StaleConversationState,
  );
});

test('mode state machine rejects bypasses and closed conversation reactivation', async () => {
  let calls = 0;
  const repo = repository();
  repo.changeMode = async () => {
    calls += 1;
    return true;
  };
  const service = new ConversationStateService(repo);
  await assert.rejects(
    service.changeMode(ids.tenantId, ids.conversationId, 0n, 'AI_PAUSED', 'HUMAN_ACTIVE'),
    StaleConversationState,
  );
  await assert.rejects(
    service.changeMode(ids.tenantId, ids.conversationId, 0n, 'CLOSED', 'AI_ACTIVE'),
    StaleConversationState,
  );
  assert.equal(calls, 0);
  await service.changeMode(ids.tenantId, ids.conversationId, 0n, 'AI_PAUSED', 'AI_ACTIVE');
  assert.equal(calls, 1);
});
