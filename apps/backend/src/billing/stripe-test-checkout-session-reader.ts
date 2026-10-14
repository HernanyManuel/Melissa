// Test-mode-only Checkout Session reader. No account routing from metadata.
export interface StripeCheckoutLinkProvider {
  retrieveSession(id: string): Promise<unknown>;
  retrieveSubscription(id: string): Promise<unknown>;
}

export interface VerifiedCheckoutSession {
  id: string;
  reference: string;
  customer: string;
  subscription: string;
  created: Date;
  expiresAt: Date;
  paid: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const seconds = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 1000000000 && n < 253402300800;

// Separate paid status from a completed-but-unpaid session. A completed
// session alone is never evidence of a completed recurring payment.
// prettier-ignore
export function stripeTestCheckoutSessionSnapshot(input: unknown): VerifiedCheckoutSession | null {
  const row = object(input);
  if (!row || row.object !== 'checkout.session' || row.livemode !== false ||
      row.mode !== 'subscription' || row.status !== 'complete' ||
      typeof row.id !== 'string' || !/^cs_test_[A-Za-z0-9_]{1,240}$/.test(row.id) ||
      typeof row.client_reference_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.client_reference_id) ||
      typeof row.customer !== 'string' || !/^cus_[A-Za-z0-9_]{1,250}$/.test(row.customer) ||
      typeof row.subscription !== 'string' || !/^sub_[A-Za-z0-9_]{1,250}$/.test(row.subscription) ||
      !seconds(row.created) || !seconds(row.expires_at) ||
      row.expires_at <= row.created ||
      !['paid', 'unpaid', 'no_payment_required'].includes(row.payment_status as string))
    return null;
  return {
    id: row.id, reference: row.client_reference_id,
    customer: row.customer, subscription: row.subscription,
    created: new Date(row.created * 1000),
    expiresAt: new Date(row.expires_at * 1000),
    paid: row.payment_status === 'paid',
  };
}

export class StripeTestCheckoutSessionReader {
  constructor(
    private readonly key: string,
    private readonly http: typeof fetch = fetch,
  ) {
    if (!/^sk_test_[A-Za-z0-9_-]{16,256}$/.test(key))
      throw new Error('Stripe session reader requires a test key');
  }

  async retrieveSession(id: string): Promise<unknown> {
    if (!/^cs_test_[A-Za-z0-9_]{1,240}$/.test(id))
      throw new Error('Invalid Stripe test Checkout Session');
    const response = await this.http('https://api.stripe.com/v1/checkout/sessions/' + id, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: 'Bearer ' + this.key,
        'Stripe-Version': '2025-09-30.clover',
        Accept: 'application/json',
      },
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('application/json') ||
      !response.body
    )
      throw new Error('Stripe Checkout unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 128 * 1024) throw new Error('Stripe response size exceeded');
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
}
