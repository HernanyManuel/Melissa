import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { SecretResolver, SecretUnavailable, validateSecretReference } from './secret-resolver';

const REFERENCE = /^secret:\/\/([a-zA-Z0-9_-]{1,128}(?:\/[a-zA-Z0-9_-]{1,128}){0,7})$/;
const MAX_SECRET_BYTES = 4096;

/**
 * Resolves opaque references from a read-only mounted secret directory.
 * The configured root and every target are canonicalized before reading so a
 * reference cannot escape the mount through path traversal or symlinks.
 */
export class MountedFileSecretResolver implements SecretResolver {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<MountedFileSecretResolver> {
    if (!isAbsolute(root) || root !== root.trim()) throw new SecretUnavailable();
    try {
      const canonical = await realpath(root);
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) throw new SecretUnavailable();
      return new MountedFileSecretResolver(canonical);
    } catch {
      throw new SecretUnavailable();
    }
  }

  async resolve(reference: string): Promise<string> {
    const validated = validateSecretReference(reference);
    const match = REFERENCE.exec(validated);
    if (!match) throw new SecretUnavailable();
    try {
      const target = join(this.root, ...match[1].split('/'));
      const canonical = await realpath(target);
      if (!canonical.startsWith(`${this.root}${sep}`)) throw new SecretUnavailable();
      const metadata = await stat(canonical);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SECRET_BYTES)
        throw new SecretUnavailable();
      const bytes = await readFile(canonical);
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_SECRET_BYTES)
        throw new SecretUnavailable();
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (
        value.length < 1 ||
        value.length > MAX_SECRET_BYTES ||
        value !== value.trim() ||
        /[\u0000-\u001f\u007f]/.test(value)
      )
        throw new SecretUnavailable();
      return value;
    } catch {
      throw new SecretUnavailable();
    }
  }
}
