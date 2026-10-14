import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, Configuration } from '../config';
import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';

// ADR-112: a Stripe TEST-only, READ-ONLY Customer Portal boundary. Never
// accept a customer ID, return URL, configuration or subscription from HTTP.
export interface StripePortalLaunch {
  customerId: string;
  subscriptionId: string;
  priceId: string;
  configurationId: string;
  origin: string;
  tenantId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const STRIPE_ORIGIN = 'https://api.stripe.com';
const STRIPE_VERSION = '2025-09-30.clover';

@Injectable()
export class StripePortalGateway {
  constructor(@Inject(CONFIG) private readonly config: Configuration) {}

  open(input: StripePortalLaunch): Promise<{ url: string }> {
    return new StripeTestPortalProvider(this.config.STRIPE_TEST_SECRET_KEY ?? '').open(input);
  }
}

export class StripeTestPortalProvider {
  constructor(
    private readonly key: string,
    private readonly http: typeof fetch = fetch,
  ) {
    if (!/^sk_test_[A-Za-z0-9_-]{16,256}$/.test(key))
      throw new Error('Stripe Portal requires test-mode credentials');
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.http(STRIPE_ORIGIN + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + this.key,
        'Stripe-Version': STRIPE_VERSION,
        Accept: 'application/json',
        ...init.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('application/json') ||
      !response.body
    )
      throw new Error('Stripe test Portal unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 128 * 1024) throw new Error('Stripe Portal response too large');
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    if (!result) throw new Error('Invalid Stripe Portal provider response');
    return result;
  }

  async open(input: StripePortalLaunch): Promise<{ url: string }> {
    if (
      !/^cus_[A-Za-z0-9_]{1,250}$/.test(input.customerId) ||
      !/^sub_[A-Za-z0-9_]{1,250}$/.test(input.subscriptionId) ||
      !/^price_[A-Za-z0-9_-]{1,249}$/.test(input.priceId) ||
      !/^bpc_[A-Za-z0-9_]{1,240}$/.test(input.configurationId) ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(input.tenantId)
    )
      throw new Error('Invalid tenant-bound Stripe Portal mapping');

    const origin = new URL(input.origin);
    if (
      !(['https:'].includes(origin.protocol) ||
        (origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) ||
      origin.origin !== input.origin || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.username || origin.password
    )
      throw new Error('Untrusted Stripe Portal return origin');

    const sub = stripeTestSubscriptionSnapshot(
      await this.request('/v1/subscriptions/' + input.subscriptionId, { method: 'GET' }),
    );
    if (
      !sub || sub.id !== input.subscriptionId ||
      sub.customer !== input.customerId || sub.price !== input.priceId ||
      sub.status !== 'active' || sub.trialEnd !== null ||
      sub.periodEnd <= new Date()
    )
      throw new Error('Stripe test subscription is not verified for Portal');

    const configuration = await this.request(
      '/v1/billing_portal/configurations/' + input.configurationId,
      { method: 'GET' },
    );
    const features = record(configuration.features);
    const invoice = record(features?.invoice_history);
    const login = record(configuration.login_page);
    if (
      configuration.object !== 'billing_portal.configuration' ||
      configuration.id !== input.configurationId ||
      configuration.livemode !== false || configuration.active !== true ||
      invoice?.enabled !== true || login?.enabled !== false ||
      !features ||
      Object.entries(features).some(([name, value]) =>
        name !== 'invoice_history' && record(value)?.enabled !== false
      )
    )
      throw new Error('Stripe test Portal configuration is not strictly read-only');

    const returnUrl = input.origin + '/billing/' + input.tenantId + '?portal=return';
    const body = new URLSearchParams({
      customer: input.customerId,
      configuration: input.configurationId,
      return_url: returnUrl,
    });
    const session = await this.request('/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (
      session.object !== 'billing_portal.session' ||
      session.livemode !== false ||
      typeof session.id !== 'string' || !/^bps_[A-Za-z0-9_]{1,250}$/.test(session.id) ||
      session.customer !== input.customerId ||
      session.configuration !== input.configurationId ||
      session.return_url !== returnUrl ||
      typeof session.created !== 'number' ||
      !Number.isSafeInteger(session.created) ||
      Math.abs(Date.now() - session.created * 1000) > 300000 ||
      typeof session.url !== 'string'
    )
      throw new Error('Invalid Stripe TEST Portal session');
    const link = new URL(session.url);
    if (
      link.protocol !== 'https:' || link.hostname !== 'billing.stripe.com' ||
      !/^\/p\/session\/test_[A-Za-z0-9_-]+$/.test(link.pathname) ||
      link.port || link.username || link.password || link.hash || link.search
    )
      throw new Error('Unexpected Stripe Portal redirect host');
    return { url: session.url };
  }
}
