import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isHumanOutboundJob } from '../src/messaging/human-outbound-queue';

test('human outbound queue accepts only minimal bounded jobs', () => {
  const id = randomUUID();
  assert(isHumanOutboundJob('human-outbound', { id, attempt: 0 }));
  assert(isHumanOutboundJob('human-outbound', { id, attempt: 4 }));
  assert(!isHumanOutboundJob('human-outbound', { id, attempt: 5 }));
  assert(!isHumanOutboundJob('human-outbound', { id, attempt: -1 }));
  assert(!isHumanOutboundJob('human-outbound', { id, attempt: 0, tenantId: randomUUID() }));
  assert(!isHumanOutboundJob('wrong', { id, attempt: 0 }));
  assert(!isHumanOutboundJob('human-outbound', { id: 'invalid', attempt: 0 }));
});
