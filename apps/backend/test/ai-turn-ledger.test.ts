import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AITurnLedger,
  AITurnLedgerRepository,
  AITurnRecord,
  InvalidAITurn,
} from '../src/ai/ai-turn-ledger';

const ids = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  turnId: '00000000-0000-4000-8000-000000000002',
  conversationId: '00000000-0000-4000-8000-000000000003',
  customerId: '00000000-0000-4000-8000-000000000004',
};
const start = { ...ids, modeEpoch: 3n, stateVersion: 7n };
const finish = {
  tenantId: ids.tenantId,
  turnId: ids.turnId,
  outcome: 'completed' as const,
  rounds: 2,
  toolCalls: 1,
  failureCode: null,
  providerKey: 'openai',
  modelKey: 'configured-model',
  inputTokens: 120,
  outputTokens: 30,
};

function repository(begin: 'started' | AITurnRecord = 'started'): AITurnLedgerRepository {
  return { begin: async () => begin, finish: async () => true };
}

test('AI turn begin is replay-safe only for the exact immutable scope', async () => {
  assert.equal(await new AITurnLedger(repository()).begin(start), 'started');
  assert.equal(
    await new AITurnLedger(
      repository({
        conversationId: ids.conversationId,
        customerId: ids.customerId,
        modeEpoch: 3n,
        stateVersion: 7n,
        status: 'running',
      }),
    ).begin(start),
    'running',
  );
  await assert.rejects(
    new AITurnLedger(
      repository({
        conversationId: ids.conversationId,
        customerId: ids.customerId,
        modeEpoch: 4n,
        stateVersion: 7n,
        status: 'completed',
      }),
    ).begin(start),
    InvalidAITurn,
  );
});

test('AI turn finish propagates bounded metadata and reports duplicate completion', async () => {
  let captured: unknown;
  const repo = repository();
  repo.finish = async (input) => {
    captured = input;
    return false;
  };
  assert.equal(await new AITurnLedger(repo).finish(finish), 'already_finished');
  assert.deepEqual(captured, finish);
});

test('AI turn ledger rejects invalid usage and failure shapes before persistence', async () => {
  const ledger = new AITurnLedger(repository());
  for (const invalid of [
    { ...finish, inputTokens: -1 },
    { ...finish, rounds: 5 },
    { ...finish, toolCalls: 9 },
    { ...finish, providerKey: 'OpenAI' },
    { ...finish, modelKey: '' },
    { ...finish, modelKey: 'model with spaces' },
    { ...finish, rounds: 0 },
    { ...finish, outcome: 'failed' as const, failureCode: null },
    { ...finish, outcome: 'completed' as const, failureCode: 'unexpected' },
    { ...finish, outcome: 'stale' as const, failureCode: 'Contains spaces' },
  ])
    await assert.rejects(ledger.finish(invalid), InvalidAITurn);
  await assert.rejects(ledger.begin({ ...start, tenantId: 'not-a-uuid' }), InvalidAITurn);
});
