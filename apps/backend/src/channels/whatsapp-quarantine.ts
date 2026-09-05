import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { InboundResult } from './inbound-provider';
import { QUARANTINE_CAPACITY } from './quarantine-policy';

export interface QuarantineKey {
  id: string;
  key: Buffer;
}

function isMediaPayload(event: InboundResult['unsupportedEvents'][number]): boolean {
  if (event.category !== 'message') return false;
  const type = event.payload.type;
  if (!['audio', 'document', 'image', 'video'].includes(String(type))) return false;
  const detail = event.payload[String(type)];
  return (
    !!detail &&
    typeof detail === 'object' &&
    typeof (detail as Record<string, unknown>).id === 'string' &&
    typeof (detail as Record<string, unknown>).mime_type === 'string'
  );
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Quarantine payload too deep');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Invalid quarantine payload');
    return encoded;
  }
  if (Array.isArray(value))
    return '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']';
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item, depth + 1))
      .join(',') +
    '}'
  );
}

export async function quarantineWhatsApp(
  tx: Prisma.TransactionClient,
  route: { tenantId: string; channelId: string },
  event: InboundResult['unsupportedEvents'][number],
  encryption: QuarantineKey,
) {
  if (encryption.key.length !== 32 || !/^[a-zA-Z0-9_-]{1,64}$/.test(encryption.id))
    throw new Error('Invalid quarantine key');
  const { tenantId, channelId } = route;
  const serialized = canonical(event.payload);
  const payloadHash = createHash('sha256').update(serialized).digest('hex');
  const externalEventId = createHash('sha256')
    .update(JSON.stringify([channelId, event.category, event.messageId, event.timestamp]))
    .digest('hex');
  const previous = await tx.externalEvent.findUnique({
    where: {
      provider_externalEventId: { provider: 'whatsapp-quarantine', externalEventId },
    },
  });
  if (previous) {
    if (previous.payloadHash !== payloadHash) {
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'whatsapp',
          action: 'message.quarantine_conflict',
          targetId: previous.id,
        },
      });
      return { conflict: true as const };
    }
    return { conflict: false as const, eventId: previous.id, duplicate: true };
  }
  if ((await tx.whatsAppQuarantine.count({ where: { tenantId } })) >= QUARANTINE_CAPACITY)
    throw new Error('Quarantine capacity exceeded');
  const stored = await tx.externalEvent.create({
    data: {
      tenantId,
      provider: 'whatsapp-quarantine',
      externalEventId,
      eventType: 'message.quarantined',
      payloadHash,
      processedAt: new Date(),
    },
  });
  const nonce = randomBytes(12);
  const aad = JSON.stringify([tenantId, channelId, stored.id, encryption.id]);
  const cipher = createCipheriv('aes-256-gcm', encryption.key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const quarantine = await tx.whatsAppQuarantine.create({
    data: {
      tenantId,
      id: stored.id,
      channelId,
      keyId: encryption.id,
      nonce,
      ciphertext,
      tag: cipher.getAuthTag(),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
  });
  await tx.quarantineExpiry.create({
    data: {
      tenantId,
      id: stored.id,
      expiresAt: quarantine.expiresAt,
    },
  });
  if (isMediaPayload(event))
    await tx.mediaIngestionDispatch.create({ data: { tenantId, id: stored.id } });
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorType: 'whatsapp',
      action: 'message.whatsapp_quarantined',
      targetId: stored.id,
    },
  });
  return { conflict: false as const, eventId: stored.id, duplicate: false };
}
