import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MountedFileSecretResolver } from '../src/secrets/mounted-file-secret-resolver';
import { SecretUnavailable } from '../src/secrets/secret-resolver';

test('mounted secret resolver observes atomic rotation without restart or stale fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melissa-secrets-rotation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, 'current');
  await writeFile(current, 'synthetic-token-v1');
  const resolver = await MountedFileSecretResolver.create(root);
  assert.equal(await resolver.resolve('secret://current'), 'synthetic-token-v1');

  const replacement = join(root, 'replacement');
  await writeFile(replacement, 'synthetic-token-v2');
  await rename(replacement, current);
  assert.equal(await resolver.resolve('secret://current'), 'synthetic-token-v2');

  await rm(current);
  await assert.rejects(() => resolver.resolve('secret://current'), SecretUnavailable);
});

test('mounted secret resolver follows an in-root version symlink after atomic rotation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melissa-secrets-symlink-rotation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'v1'), 'synthetic-token-v1');
  await writeFile(join(root, 'v2'), 'synthetic-token-v2');
  await symlink(join(root, 'v1'), join(root, 'current'));
  const resolver = await MountedFileSecretResolver.create(root);
  assert.equal(await resolver.resolve('secret://current'), 'synthetic-token-v1');

  await symlink(join(root, 'v2'), join(root, 'next'));
  await rename(join(root, 'next'), join(root, 'current'));
  assert.equal(await resolver.resolve('secret://current'), 'synthetic-token-v2');
});
