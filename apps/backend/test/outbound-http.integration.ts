import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { OpenAPIObject } from '@nestjs/swagger';

export interface OutboundHttpFixture {
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
    for (const code of ['200', '400', '401', '403', '404', '500'])
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
    assert.equal(body.state, 'stored');
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
      if (allowed) assert.deepEqual(await read.json(), { intentId: id, state: 'stored' });
    }
  } finally {
    await db.membership.update({ where: { id: membershipId }, data: { role: 'owner' } });
  }
}
