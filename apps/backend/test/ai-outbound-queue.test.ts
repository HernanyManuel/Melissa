import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isAIAutomaticOutboundJob } from '../src/ai/ai-outbound-queue';

test('automatic outbound queue accepts only minimal valid jobs', () => {
  const id = randomUUID();
  assert.equal(
    isAIAutomaticOutboundJob('ai-automatic-outbound', { id, attempt: 0 }),
    true,
  );
  assert.equal(
    isAIAutomaticOutboundJob('ai-automatic-outbound', { id, attempt: 4 }),
    true,
  );
  assert.equal(
    isAIAutomaticOutboundJob('ai-automatic-outbound', {
      id,
      attempt: 0,
      tenantId: randomUUID(),
    }),
    false,
  );
  assert.equal(
    isAIAutomaticOutboundJob('ai-automatic-outbound', { id, attempt: 5 }),
    false,
  );
  assert.equal(
    isAIAutomaticOutboundJob('ai-automatic-outbound', { id: 'invalid', attempt: 0 }),
    false,
  );
  assert.equal(isAIAutomaticOutboundJob('other', { id, attempt: 0 }), false);
});
