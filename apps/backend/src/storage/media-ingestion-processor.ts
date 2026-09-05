import { createDecipheriv } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { isUUID } from 'class-validator';
import { MediaIngestor } from './media-ingestor';

export type QuarantineKeyResolver = (keyId: string) => Buffer | null;

interface MediaReference {
  id: string;
  contentType: string;
}

const MEDIA_TYPES = new Set(['audio', 'document', 'image', 'video']);
const MEDIA_ID = /^[a-zA-Z0-9_-]{1,256}$/;

export class MediaIngestionProcessor {
  constructor(
    private readonly db: PrismaClient,
    private readonly ingestor: MediaIngestor,
    private readonly resolveKey: QuarantineKeyResolver,
  ) {}

  async process(id: string, attempt: number): Promise<void> {
    if (!isUUID(id) || !Number.isInteger(attempt) || attempt < 0 || attempt >= 5)
      throw new Error('Invalid media ingestion job');
    // Queue data never supplies a tenant. The minimal durable envelope is authoritative.
    const route = await this.db.mediaIngestionDispatch.findUnique({ where: { id } });
    if (
      !route ||
      route.state !== 'quarantined' ||
      route.attempts !== attempt ||
      route.nextAttemptAt > new Date()
    )
      return;
    try {
      const reference = await this.readReference(route.tenantId, id);
      const stored = await this.ingestor.ingest(
        route.tenantId,
        reference.id,
        reference.contentType,
      );
      await this.settleSuccess(route.tenantId, id, attempt, stored);
    } catch {
      await this.settleFailure(route.tenantId, id, attempt);
      throw new Error('Media ingestion failed');
    }
  }

  private async readReference(tenantId: string, id: string): Promise<MediaReference> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      const row = await tx.whatsAppQuarantine.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id } },
      });
      const key = this.resolveKey(row.keyId);
      if (!key || key.length !== 32) throw new Error('Quarantine key unavailable');
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(JSON.stringify([tenantId, row.channelId, id, row.keyId])));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      if (plaintext.byteLength > 65536) throw new Error('Invalid media envelope');
      const payload = JSON.parse(plaintext.toString('utf8')) as unknown;
      return this.extractReference(payload);
    });
  }

  private extractReference(payload: unknown): MediaReference {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Invalid media envelope');
    const record = payload as Record<string, unknown>;
    if (typeof record.type !== 'string' || !MEDIA_TYPES.has(record.type))
      throw new Error('Invalid media envelope');
    const detail = record[record.type];
    if (!detail || typeof detail !== 'object' || Array.isArray(detail))
      throw new Error('Invalid media envelope');
    const media = detail as Record<string, unknown>;
    if (
      typeof media.id !== 'string' ||
      !MEDIA_ID.test(media.id) ||
      typeof media.mime_type !== 'string'
    )
      throw new Error('Invalid media envelope');
    return { id: media.id, contentType: media.mime_type };
  }

  private async settleSuccess(
    tenantId: string,
    id: string,
    attempt: number,
    stored: { key: string; contentType: string; size: number; checksumSha256: string },
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${tenantId}::uuid FOR UPDATE`;
      const current = await tx.mediaIngestionDispatch.findUniqueOrThrow({ where: { id } });
      if (current.state !== 'quarantined' || current.attempts !== attempt) return;
      await tx.mediaIngestionDispatch.update({
        where: { id },
        data: {
          state: 'stored',
          storageKey: stored.key,
          contentType: stored.contentType,
          sizeBytes: stored.size,
          checksumSha256: stored.checksumSha256,
        },
      });
      await tx.auditEvent.create({
        data: { tenantId, actorType: 'system', action: 'media.ingestion_stored', targetId: id },
      });
    });
  }

  private async settleFailure(tenantId: string, id: string, attempt: number): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${tenantId}::uuid FOR UPDATE`;
      const current = await tx.mediaIngestionDispatch.findUniqueOrThrow({ where: { id } });
      if (current.state !== 'quarantined' || current.attempts !== attempt) return;
      const attempts = attempt + 1;
      await tx.mediaIngestionDispatch.update({
        where: { id },
        data: {
          attempts,
          state: attempts === 5 ? 'failed' : 'quarantined',
          nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** attempt)),
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'system',
          action: attempts === 5 ? 'media.ingestion_failed' : 'media.ingestion_retry',
          targetId: id,
        },
      });
    });
  }
}
