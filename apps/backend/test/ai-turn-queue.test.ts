import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isAITurnJob } from '../src/ai/ai-turn-queue';

test('AI turn queue accepts only minimal valid jobs', () => {
  const id = randomUUID();
  assert.equal(isAITurnJob('ai-conversation-turn', { id, attempt: 0 }), true);
  assert.equal(isAITurnJob('ai-conversation-turn', { id, attempt: 4 }), true);
  assert.equal(
    isAITurnJob('ai-conversation-turn', {
      id,
      attempt: 0,
      tenantId: randomUUID(),
    }),
    false,
  );
  assert.equal(isAITurnJob('ai-conversation-turn', { id, attempt: 5 }), false);
  assert.equal(isAITurnJob('ai-conversation-turn', { id: 'invalid', attempt: 0 }), false);
  assert.equal(isAITurnJob('other', { id, attempt: 0 }), false);
});
