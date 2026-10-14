// ADR-109: fixed-origin Stripe TEST Checkout boundary. No live keys, no
// redirects, and no unbounded provider responses. No tenant decisions from Stripe metadata.
export interface CheckoutPlanPrice {
  priceId: string;
  productId: string;
  amount: string;
  currency: string;
  interval: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
}

type HttpFetch = typeof fetch;
const STRIPE_ORIGIN = 'https://api.stripe.com';
const STRIPE_VERSION = '2025-09-30.clover';

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

// Exact two-decimal catalog amounts only in this limited test-mode increment.
// Other currencies and arbitrary decimal fractions fail closed until pricing is specified.
export function minorUnits(amount: string): number | null {
  if (!/^\\d{1,10}(?:\\.\\d{1,6})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.slice(2).replace(/0/g, '') !== '') return null;
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return Number.isSafeInteger(result) && result > 0 && result <= 99999999 ? result : null;
}

import { Injectable, Inject } from '@nestjs/common';
import { CONFIG, Configuration } from '../config';

@Injectable()
export class StripeCheckoutGateway {
  constructor(@Inject(CONFIG) private readonly config: Configuration) {}
  private get provider(): StripeTestCheckoutProvider {
    return new StripeTestCheckoutProvider(this.config.STRIPE_TEST_SECRET_KEY ?? '');
  }
  validatePrice(plan: CheckoutPlanPrice) { return this.provider.validatePrice(plan); }
  createSession(args: {
    intentId: string; priceId: string; tenantId: string; origin: string; expiresAt: Date; expiresAt: Date;
  }) { return this.provider.createSession(args); }
}

export class StripeTestCheckoutProvider {
  constructor(private readonly secretKey: string, private readonly http: HttpFetch = fetch) {
    if (!/^sk_test_[A-Za-z0-9_-]{16,256}$/.test(secretKey))
      throw new Error('Stripe Checkout requires a test-mode key');
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.http(STRIPE_ORIGIN + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + this.secretKey,
        'Stripe-Version': STRIPE_VERSION,
        Accept: 'application/json',
        ...init.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200 || !res.headers.get('content-type')?.includes('application/json') ||
        !res.body) throw new Error('Stripe test provider unavailable');
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 128 * 1024) throw new Error('Stripe response exceeded limit');
        parts.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = object(JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown);
    if (!result) throw new Error('Invalid Stripe response');
    return result;
  }

  async validatePrice(plan: CheckoutPlanPrice): Promise<void> {
    if (!/^price_[a-zA-Z0-9_-]{1,249}$/.test(plan.priceId) ||
        !/^prod_[a-zA-Z0-9_-]{1,249}$/.test(plan.productId) ||
        !['EUR', 'USD'].includes(plan.currency) ||
        !['month', 'year'].includes(plan.interval))
      throw new Error('Checkout plan mapping is incomplete');
    const amount = minorUnits(plan.amount);
    if (amount === null) throw new Error('Unsupported catalog price');
    const price = await this.request('/v1/prices/' + plan.priceId, { method: 'GET' });
    const recurring = object(price.recurring);
    if (price.object !== 'price' || price.id !== plan.priceId ||
        price.livemode !== false || price.active !== true ||
        price.type !== 'recurring' || price.product !== plan.productId ||
        price.currency !== plan.currency.toLowerCase() ||
        price.unit_amount !== amount ||
        price.billing_scheme !== 'per_unit' ||
        recurring?.interval !== plan.interval ||
        recurring?.usage_type !== 'licensed' ||
        recurring?.interval_count !== 1)
      throw new Error('Stripe test price does not match catalog');
  }

  async createSession(args: {
    intentId: string; priceId: string; tenantId: string; origin: string;
  }): Promise<CheckoutSession> {
    const params = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': args.priceId,
      'line_items[0][quantity]': '1',
      client_reference_id: args.intentId,
      expires_at: Math.floor(args.expiresAt.getTime() / 1000).toString(),
      success_url: args.origin + '/billing/' + args.tenantId + '?checkout=return',
      cancel_url: args.origin + '/billing/' + args.tenantId + '?checkout=cancel',
    });
    const session = await this.request('/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': 'melissa-test-checkout-' + args.intentId,
      },
      body: params,
    });
    const expires = session.expires_at;
    if (session.object !== 'checkout.session' || session.livemode !== false ||
        session.mode !== 'subscription' || session.status !== 'open' ||
        session.client_reference_id !== args.intentId ||
        typeof session.id !== 'string' || !/^cs_test_[a-zA-Z0-9_]{1,240}$/.test(session.id) ||
        typeof session.url !== 'string' ||
        typeof expires !== 'number' || !Number.isSafeInteger(expires) ||
        expires * 1000 <= Date.now() || expires * 1000 > Date.now() + 86400000)
      throw new Error('Invalid Stripe test Checkout session');
    const url = new URL(session.url);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' ||
        url.port || url.username || url.password || url.hash)
      throw new Error('Unexpected Stripe checkout redirect');
    return { id: session.id, url: session.url, expiresAt: new Date(expires * 1000) };
  }
}
