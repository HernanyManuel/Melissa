import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { OpenAPIObject } from '@nestjs/swagger';
import Redis from 'ioredis';
import { consumeOutboundLimit, outboundLimitKey } from '../src/messaging/outbound-rate-limit';

export interface OutboundHttpFixture {
  redis: Redis;
  call(method: string, path: string, body?: object, token?: string): Promise<Response>;
  ownerToken: string;
  otherToken: string;
}

export function assertOutboundOpenApi(doc: OpenAPIObject) {
  const post =
    doc.paths['/api/v1/tenants/{tenantId}/conversations/{id}/mock-outbound-intents']?.post;
  const get = doc.paths['/api/v1/tenants/{tenantId}/outbound-intents/{id}']?.get;
  assert(post && get);
  assert.equal(post.operationId, 'storeMockOutboundIntent');
  assert.equal(get.operationId, 'getStoredOutboundIntent');
  for (const operation of [post, get]) {
    assert.deepEqual(operation.security, [{ bearer: [] }]);
    for (const code of ['200', '400', '401', '403', '404', '429', '500', '503'])
      assert(operation.responses[code]);
    assert(!operation.responses['202']);
    const parameters = operation.parameters?.filter((p) => !('$ref' in p)) ?? [];
    assert.equal(parameters.length, 2);
    assert(parameters.every((p) => !('$ref' in p) && p.in === 'path' && p.required));
  }
  assert(post.responses['409']);
  const schemas = doc.components?.schemas;
  for (const [name, fields] of [
    ['StoreMockOutboundDto', ['requestId', 'text']],
    ['StoredOutboundDto', ['intentId', 'state']],
    ['StoreMockOutboundResponseDto', ['duplicate', 'intentId', 'state']],
  ] as const) {
    const schema = schemas?.[name];
    assert(schema && !('$ref' in schema));
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...fields].sort());
    assert.deepEqual([...(schema.required ?? [])].sort(), [...fields].sort());
  }
  const receiptState = schemas?.StoredOutboundDto;
  assert(receiptState && !('$ref' in receiptState));
  const stateSchema = receiptState.properties?.state;
  assert(stateSchema && !('$ref' in stateSchema));
  assert.deepEqual(stateSchema.enum, ['stored', 'pending', 'mock_accepted', 'rejected', 'failed']);
}

export async function testOutboundHttp(
  db: PrismaClient,
  tenantId: string,
  otherTenant: string,
  conversationId: string,
  membershipId: string,
  http: OutboundHttpFixture,
) {
  const { call, ownerToken, otherToken } = http;
  const path = `/tenants/${tenantId}/conversations/${conversationId}/mock-outbound-intents`;
  const input = { requestId: randomUUID(), text: 'HTTP private test text' };
  assert.equal((await call('POST', path, input)).status, 401);
  assert.equal((await call('POST', path, input, otherToken)).status, 404);
  for (const body of [
    { ...input, tenantId },
    { ...input, conversationId },
    { ...input, text: ' \t\n' },
    { ...input, requestId: 'invalid' },
    { requestId: input.requestId },
    { ...input, text: 'x'.repeat(4097) },
    { ...input, text: 42 },
  ])
    assert.equal((await call('POST', path, body, ownerToken)).status, 400);
  const responses = await Promise.all([
    call('POST', path, input, ownerToken),
    call('POST', path, input, ownerToken),
  ]);
  const bodies: Array<{ intentId: string; duplicate: boolean; state: string }> = [];
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert(response.headers.get('x-request-id'));
    bodies.push((await response.json()) as { intentId: string; duplicate: boolean; state: string });
  }
  assert.equal(bodies[0]!.intentId, bodies[1]!.intentId);
  assert.equal(bodies.filter((b) => b.duplicate).length, 1);
  for (const body of bodies) {
    assert.deepEqual(Object.keys(body).sort(), ['duplicate', 'intentId', 'state']);
    assert(['pending', 'mock_accepted'].includes(body.state));
  }
  const id = bodies[0]!.intentId;
  const receipt = `/tenants/${tenantId}/outbound-intents/${id}`;
  assert.equal((await call('GET', receipt)).status, 401);
  assert.equal((await call('GET', receipt, undefined, otherToken)).status, 404);
  assert.equal(
    (await call('GET', `/tenants/${otherTenant}/outbound-intents/${id}`, undefined, otherToken))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        'GET',
        `/tenants/${tenantId}/outbound-intents/${randomUUID()}`,
        undefined,
        ownerToken,
      )
    ).status,
    404,
  );
  assert.equal(
    (await call('GET', `/tenants/${tenantId}/outbound-intents/invalid`, undefined, ownerToken))
      .status,
    400,
  );
  const conflict = await call('POST', path, { ...input, text: 'changed' }, ownerToken);
  assert.equal(conflict.status, 409);
  const error = await conflict.text();
  assert(!error.includes(input.text));
  assert(!error.includes('stack'));
  assert.equal(
    await db.auditEvent.count({
      where: { tenantId, targetId: id, action: 'outbound.intent_stored' },
    }),
    1,
  );
  assert.equal(
    await db.auditEvent.count({
      where: { tenantId, targetId: id, action: 'outbound.intent_conflict' },
    }),
    1,
  );
  try {
    for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer'] as const) {
      await db.membership.update({ where: { id: membershipId }, data: { role } });
      const allowed = role === 'owner' || role === 'admin';
      const read = await call('GET', receipt, undefined, ownerToken);
      assert.equal(read.status, allowed ? 200 : 403);
      assert.equal((await call('POST', path, input, ownerToken)).status, allowed ? 200 : 403);
      if (allowed) {
        const body = (await read.json()) as { intentId: string; state: string };
        assert.equal(body.intentId, id);
        assert(['pending', 'mock_accepted', 'rejected', 'failed'].includes(body.state));
      }
    }
  } finally {
    await db.membership.update({ where: { id: membershipId }, data: { role: 'owner' } });
  }
  const member = await db.membership.findUniqueOrThrow({ where: { id: membershipId } });
  const key = outboundLimitKey(member.userId, 'store');
  const isolatedUser = randomUUID();
  const isolatedKey = outboundLimitKey(isolatedUser, 'store');
  try {
    const waits = await Promise.all(
      Array.from({ length: 35 }, () => consumeOutboundLimit(http.redis, isolatedUser, 'store')),
    );
    assert.equal(waits.filter((wait) => wait === 0).length, 30);
    assert(waits.filter((wait) => wait > 0).every((wait) => wait <= 60));
    assert.equal(await http.redis.get(isolatedKey), '30');
    assert((await http.redis.pttl(isolatedKey)) > 0);
    await http.redis.set(key, '30', 'PX', 60000);
    const rejectedKey = randomUUID();
    const limited = await call('POST', path, { ...input, requestId: rejectedKey }, ownerToken);
    assert.equal(limited.status, 429);
    assert(limited.headers.get('access-control-expose-headers')?.includes('Retry-After'));
    assert(Number(limited.headers.get('retry-after')) >= 1);
    assert(Number(limited.headers.get('retry-after')) <= 60);
    assert.equal((await call('GET', receipt, undefined, ownerToken)).status, 200);
    assert.equal(await db.outboundIntent.count({ where: { tenantId, requestId: rejectedKey } }), 0);
    // Corrupt/unavailable limiter state must fail closed, without persisting the body.
    await http.redis.set(key, 'invalid', 'PX', 60000);
    assert.equal(
      (await call('POST', path, { ...input, requestId: rejectedKey }, ownerToken)).status,
      503,
    );
    assert.equal(await db.outboundIntent.count({ where: { tenantId, requestId: rejectedKey } }), 0);
    // Removing this synthetic counter simulates the next window; replay preserves identity.
    await http.redis.del(key);
    const replay = await call('POST', path, input, ownerToken);
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as {
      intentId: string;
      duplicate: boolean;
      state: string;
    };
    assert.equal(replayBody.intentId, id);
    assert.equal(replayBody.duplicate, true);
    assert(['pending', 'mock_accepted', 'rejected', 'failed'].includes(replayBody.state));
    // Repair missing expiry without making a saturated counter unlimited.
    await http.redis.set(isolatedKey, '30');
    assert.equal(await consumeOutboundLimit(http.redis, isolatedUser, 'store'), 60);
    assert((await http.redis.pttl(isolatedKey)) > 0);
  } finally {
    await http.redis.del(key, isolatedKey);
  }
}
