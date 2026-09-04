import assert from 'node:assert/strict';
import test from 'node:test';
import { probe } from './audit-connectivity.mjs';

test('bulk probe uses a fixed public sample and no authentication', async () => {
  let cancelled = false;
  const result = await probe('bulk', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { '@nestjs/core': ['11.2.3'] });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return {
      status: 200,
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    };
  });
  assert.equal(result.status, 200);
  assert.equal(cancelled, true);
  assert.equal('vulnerabilities' in result, false);
});

test('ping reports HTTP failure without treating it as audit success', async () => {
  const result = await probe('ping', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/-/ping');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return { status: 503, body: null };
  });
  assert.equal(result.status, 503);
});

test('network diagnostics never expose raw exception details', async () => {
  for (const name of ['TimeoutError', 'TypeError']) {
    const result = await probe('bulk', async () => {
      const error = new Error('secret-test-marker');
      error.name = name;
      throw error;
    });
    assert.equal(result.failure, name === 'TimeoutError' ? 'timeout' : 'request_failed');
    assert.equal(JSON.stringify(result).includes('secret-test-marker'), false);
  }
});
