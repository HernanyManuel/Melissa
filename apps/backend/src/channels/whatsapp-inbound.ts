import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { InboundProvider, InboundResult } from './inbound-provider';

const identifier = z.string().min(1).max(512);
const numericId = z.string().regex(/^\d{1,32}$/);
const timestamp = z.string().regex(/^\d{1,12}$/);
const messageSchema = z
  .object({
    id: identifier,
    from: numericId,
    timestamp,
    type: z.string().min(1).max(64),
    text: z.object({ body: z.string().min(1).max(4096) }).optional(),
  })
  .passthrough();
const statusSchema = z
  .object({
    id: identifier,
    recipient_id: numericId,
    timestamp,
    status: z.string().min(1).max(64),
  })
  .passthrough();
const valueSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: numericId }),
  messages: z.array(messageSchema).max(100).optional(),
  statuses: z.array(statusSchema).max(100).optional(),
});
const envelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        id: numericId,
        changes: z.array(z.object({ field: z.string().max(128), value: z.unknown() })).max(100),
      }),
    )
    .min(1)
    .max(20),
});

export class WebhookInputError extends Error {
  constructor(readonly code: 'configuration' | 'verification' | 'signature' | 'size' | 'payload') {
    // Do not expose submitted tokens, body content, identifiers or schema errors.
    super(`WhatsApp webhook: ${code}`);
  }
}

export class WhatsAppInboundProvider implements InboundProvider {
  constructor(
    private readonly appSecret: string,
    private readonly verifyToken: string,
  ) {
    if (!appSecret || !verifyToken) throw new WebhookInputError('configuration');
  }

  verifyChallenge(query: Record<string, unknown>): string {
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (
      query['hub.mode'] !== 'subscribe' ||
      typeof token !== 'string' ||
      token.length > 1024 ||
      typeof challenge !== 'string' ||
      !/^\d{1,128}$/.test(challenge) ||
      !timingSafeEqual(
        createHash('sha256').update(token).digest(),
        createHash('sha256').update(this.verifyToken).digest(),
      )
    )
      throw new WebhookInputError('verification');
    return challenge;
  }

  decode(rawBody: Buffer, signature: unknown): InboundResult {
    if (rawBody.length === 0 || rawBody.length > 256 * 1024) throw new WebhookInputError('size');
    if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
      throw new WebhookInputError('signature');
    const expected = createHmac('sha256', this.appSecret).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
      throw new WebhookInputError('signature');
    try {
      // Signature must be verified before parsing. Re-serializing JSON changes the signed bytes.
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
      return this.normalize(body);
    } catch {
      throw new WebhookInputError('payload');
    }
  }

  private normalize(body: unknown): InboundResult {
    const envelope = envelopeSchema.parse(body);
    const result: InboundResult = { events: [], unsupported: 0, unsupportedEvents: [] };
    for (const entry of envelope.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') {
          result.unsupported++;
          continue;
        }
        const value = valueSchema.parse(change.value);
        if (!value.messages?.length && !value.statuses?.length) result.unsupported++;
        const scope = {
          provider: 'whatsapp' as const,
          accountId: entry.id,
          phoneId: value.metadata.phone_number_id,
        };
        for (const message of value.messages ?? []) {
          if (message.type !== 'text') {
            result.unsupported++;
            result.unsupportedEvents.push({
              accountId: entry.id,
              phoneId: scope.phoneId,
              messageId: message.id,
              timestamp: message.timestamp,
              category: 'message',
              payload: message,
            });
            continue;
          }
          if (!message.text) throw new WebhookInputError('payload');
          result.events.push({
            ...scope,
            kind: 'text',
            messageId: message.id,
            senderId: message.from,
            timestamp: message.timestamp,
            text: message.text.body,
          });
        }
        for (const status of value.statuses ?? []) {
          const state = status.status;
          if (state !== 'sent' && state !== 'delivered' && state !== 'read' && state !== 'failed') {
            result.unsupported++;
            result.unsupportedEvents.push({
              accountId: entry.id,
              phoneId: scope.phoneId,
              messageId: status.id,
              timestamp: status.timestamp,
              category: 'status',
              payload: status,
            });
            continue;
          }
          result.events.push({
            ...scope,
            kind: 'status',
            messageId: status.id,
            recipientId: status.recipient_id,
            timestamp: status.timestamp,
            status: state,
          });
        }
        if (result.events.length + result.unsupported > 1000) throw new WebhookInputError('size');
      }
    }
    return result;
  }
}
