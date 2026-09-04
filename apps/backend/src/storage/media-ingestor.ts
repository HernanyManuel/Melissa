import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { MediaSourceProvider } from './media-source-provider';
import { StorageMetadata, StorageProvider } from './storage-provider';

const TYPES = new Set([
  'application/pdf',
  'audio/mpeg',
  'audio/ogg',
  'image/jpeg',
  'image/png',
  'video/mp4',
]);
const MEDIA_ID = /^[a-zA-Z0-9_-]{1,256}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;

export class MediaIngestor {
  constructor(
    private readonly source: MediaSourceProvider,
    private readonly storage: StorageProvider,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {
    if (maxBytes < 1) throw new Error('Invalid media limit');
  }

  async ingest(tenantId: string, mediaId: string, declaredType: string): Promise<StorageMetadata> {
    if (!isUUID(tenantId) || !MEDIA_ID.test(mediaId) || !TYPES.has(declaredType))
      throw new Error('Invalid media request');
    tenantId = tenantId.toLowerCase();
    const media = await this.source.download(mediaId);
    if (media.contentType !== declaredType || !TYPES.has(media.contentType))
      throw new Error('Media content type mismatch');
    if (!(media.body instanceof Uint8Array) || media.body.byteLength === 0)
      throw new Error('Invalid media body');
    if (media.body.byteLength > this.maxBytes) throw new Error('Media too large');
    const checksum = createHash('sha256').update(media.body).digest('hex');
    if (
      media.checksumSha256 !== undefined &&
      (!CHECKSUM.test(media.checksumSha256) || media.checksumSha256 !== checksum)
    )
      throw new Error('Media checksum mismatch');
    const opaqueId = createHash('sha256')
      .update(this.source.providerKey)
      .update('\0')
      .update(mediaId)
      .digest('hex');
    return this.storage.put({
      key: `tenants/${tenantId}/media/${opaqueId}`,
      contentType: media.contentType,
      body: media.body,
    });
  }
}
