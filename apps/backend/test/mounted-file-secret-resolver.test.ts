import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { MountedFileSecretResolver } from '../src/secrets/mounted-file-secret-resolver';
import { SecretUnavailable } from '../src/secrets/secret-resolver';

test('mounted secret resolver reads only canonical files below configured root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melissa-secrets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tenant', 'channel'), { recursive: true });
  await writeFile(
    join(root, 'tenant', 'channel', 'whatsapp'),
    'synthetic-server-access-token',
  );
  const resolver = await MountedFileSecretResolver.create(root);
  assert.equal(
    await resolver.resolve('secret://tenant/channel/whatsapp'),
    'synthetic-server-access-token',
  );
});

test('mounted secret resolver rejects traversal and symlink escape', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'melissa-secrets-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'melissa-secrets-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'token'), 'synthetic-server-access-token');
  await symlink(join(outside, 'token'), join(root, 'escaped'));
  const resolver = await MountedFileSecretResolver.create(root);
  await assert.rejects(() => resolver.resolve('secret://../token'), SecretUnavailable);
  await assert.rejects(() => resolver.resolve('secret://escaped'), SecretUnavailable);
});

test(
  'mounted secret resolver rejects missing, oversized or control-bearing material',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'melissa-secrets-invalid-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'newline'), 'synthetic-server-access-token\n');
    await writeFile(join(root, 'large'), 'x'.repeat(4097));
    const resolver = await MountedFileSecretResolver.create(root);
    await assert.rejects(() => resolver.resolve('secret://missing'), SecretUnavailable);
    await assert.rejects(
      () => resolver.resolve('secret://newline'),
      SecretUnavailable,
    );
    await assert.rejects(() => resolver.resolve('secret://large'), SecretUnavailable);
  },
);

test('mounted secret resolver rejects a filesystem root as its secret mount', async () => {
  const filesystemRoot = parse(tmpdir()).root;
  await assert.rejects(
    () => MountedFileSecretResolver.create(filesystemRoot),
    SecretUnavailable,
  );
});

test(
  'mounted secret resolver observes atomic rotation without restart or stale fallback',
  async (t) => {
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
    await assert.rejects(
      () => resolver.resolve('secret://current'),
      SecretUnavailable,
    );
  },
);

test(
  'mounted secret resolver follows an in-root version symlink after atomic rotation',
  async (t) => {
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
  },
);
