import { createHash } from 'node:crypto';
import {
  StorageCapacityExceeded,
  StorageMetadata,
  StoragePayloadConflict,
  StorageProvider,
  StorageWrite,
  StoredObject,
} from './storage-provider';

interface Entry {
  metadata: StorageMetadata;
  body: Uint8Array;
}

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,255}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;

/** Test/development provider. Memory-only, bounded and never returns a public URL. */
export class MockStorageProvider implements StorageProvider {
  readonly providerKey = 'mock';
  private readonly entries = new Map<string, Entry>();
  private usedBytes = 0;

  constructor(
    private readonly maxObjectBytes = 10 * 1024 * 1024,
    private readonly maxTotalBytes = 50 * 1024 * 1024,
  ) {
    if (maxObjectBytes < 1 || maxTotalBytes < maxObjectBytes)
      throw new Error('Invalid mock storage limits');
  }

  async put(input: StorageWrite): Promise<StorageMetadata> {
    this.validate(input.key, input.contentType);
    if (!(input.body instanceof Uint8Array) || input.body.byteLength === 0)
      throw new Error('Invalid storage body');
    if (input.body.byteLength > this.maxObjectBytes) throw new StorageCapacityExceeded();
    const checksumSha256 = createHash('sha256')
      .update(input.contentType)
      .update('\0')
      .update(input.body)
      .digest('hex');
    const previous = this.entries.get(input.key);
    if (previous) {
      if (previous.metadata.checksumSha256 !== checksumSha256) throw new StoragePayloadConflict();
      return this.copyMetadata(previous.metadata);
    }
    if (this.usedBytes + input.body.byteLength > this.maxTotalBytes)
      throw new StorageCapacityExceeded();
    const metadata: StorageMetadata = {
      key: input.key,
      contentType: input.contentType,
      size: input.body.byteLength,
      checksumSha256,
      createdAt: new Date(),
    };
    const body = Uint8Array.from(input.body);
    // No await before reservation: concurrent calls cannot overrun the in-memory quota.
    this.entries.set(input.key, { metadata, body });
    this.usedBytes += body.byteLength;
    return this.copyMetadata(metadata);
  }

  async get(key: string): Promise<StoredObject | null> {
    this.validateKey(key);
    const entry = this.entries.get(key);
    return entry
      ? { ...this.copyMetadata(entry.metadata), body: Uint8Array.from(entry.body) }
      : null;
  }

  async delete(key: string): Promise<boolean> {
    this.validateKey(key);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.usedBytes -= entry.body.byteLength;
    return true;
  }

  private validate(key: string, contentType: string): void {
    this.validateKey(key);
    if (!CONTENT_TYPE.test(contentType)) throw new Error('Invalid storage content type');
  }

  private validateKey(key: string): void {
    if (!KEY.test(key) || key.split('/').some((part) => part.length === 0 || part === '..'))
      throw new Error('Invalid storage key');
  }

  private copyMetadata(metadata: StorageMetadata): StorageMetadata {
    return { ...metadata, createdAt: new Date(metadata.createdAt) };
  }
}
