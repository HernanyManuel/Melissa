import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { MediaSourceProvider } from './media-source-provider';
import { StorageMetadata, StorageProvider } from './storage-provider';
import { MalwareScanner } from './malware-scanner';

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

function startsWith(body: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => body[index] === value);
}

export function matchesMediaSignature(contentType: string, body: Uint8Array): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return body.length >= 3 && startsWith(body, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return body.length >= 8 && startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'application/pdf':
      return body.length >= 5 && startsWith(body, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'audio/ogg':
      return body.length >= 4 && startsWith(body, [0x4f, 0x67, 0x67, 0x53]);
    case 'audio/mpeg':
      return (
        (body.length >= 3 && startsWith(body, [0x49, 0x44, 0x33])) ||
        (body.length >= 2 && body[0] === 0xff && (body[1]! & 0xe0) === 0xe0)
      );
    case 'video/mp4':
      return (
        body.length >= 12 &&
        body[4] === 0x66 &&
        body[5] === 0x74 &&
        body[6] === 0x79 &&
        body[7] === 0x70 &&
        body.slice(8, 12).every((value) => value >= 0x20 && value <= 0x7e)
      );
    default:
      return false;
  }
}

export class MediaIngestor {
  constructor(
    private readonly source: MediaSourceProvider,
    private readonly storage: StorageProvider,
    private readonly maxBytes = 10 * 1024 * 1024,
    private readonly scanner?: MalwareScanner,
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
    if (!matchesMediaSignature(media.contentType, media.body))
      throw new Error('Media signature mismatch');
    const checksum = createHash('sha256').update(media.body).digest('hex');
    if (
      media.checksumSha256 !== undefined &&
      (!CHECKSUM.test(media.checksumSha256) || media.checksumSha256 !== checksum)
    )
      throw new Error('Media checksum mismatch');
    if (this.scanner) await this.scanner.scan({ contentType: media.contentType, body: media.body });
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
