import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Dependencies } from '../dependencies';

const supportedEvents = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

interface SignedStripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: false;
  api_version?: string | null;
  data: { object: Record<string, unknown> };
}

// Accept only bounded and coherent signed test events with the minimal
// envelope Stripe promises. No metadata-based tenant routing or side effects.
// prettier-ignore
export function parseStripeEvent(body: Buffer): SignedStripeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== 'string' ||
      !/^evt_[A-Za-z0-9_]{1,251}$/.test(e.id) ||
      typeof e.type !== 'string' || e.type.length > 128 ||
      !Number.isInteger(e.created) || (e.created as number) < 1_000_000_000 ||
      (e.created as number) > 253_402_300_799 ||
      e.livemode !== false ||
      (e.api_version !== undefined && e.api_version !== null &&
        (typeof e.api_version !== 'string' || e.api_version.length > 64)) ||
      typeof e.data !== 'object' || e.data === null || Array.isArray(e.data))
    return null;
  const data = e.data as Record<string, unknown>;
  if (typeof data.object !== 'object' || data.object === null || Array.isArray(data.object))
    return null;
  return e as unknown as SignedStripeEvent;
}

// prettier-ignore
@Injectable()
export class StripeWebhookInbox {
  constructor(private readonly deps: Dependencies) {}

  async store(rawBody: Buffer, event: SignedStripeEvent): Promise<'stored' | 'duplicate' | 'ignored'> {
    if (!supportedEvents.has(event.type)) return 'ignored';
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const payload = rawBody.toString('utf8');
    const inserted = await this.deps.db.$queryRaw<Array<{ eventId: string }>>`
      INSERT INTO stripe_webhook_events
        (event_id,event_type,api_version,provider_created_at,payload_sha256,payload,livemode)
      VALUES
        (${event.id},${event.type},${event.api_version ?? null},
         ${new Date(event.created * 1000)},${digest},${payload}::jsonb,FALSE)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id AS "eventId"
    `;
    if (inserted.length) return 'stored';
    const old = await this.deps.db.stripeWebhookEvent.findUnique({
      where: { eventId: event.id },
      select: { eventId: true, eventType: true, payloadSha256: true },
    });
    if (!old || old.payloadSha256 !== digest || old.eventType !== event.type)
      throw new ConflictException();
    return 'duplicate';
  }
}
