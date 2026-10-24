import { StripeSubscriptionReader } from './stripe-reconciler';

// Hard-coded origin, test credentials only, no redirects, bounded time/body.
// The provider response is authoritative only after matching the already
// linked subscription/customer/price against the local database.
// prettier-ignore
export class StripeTestSubscriptionReader implements StripeSubscriptionReader {
  constructor(private readonly secretKey: string) {
    if (!/^sk_test_[A-Za-z0-9_-]{16,256}$/.test(secretKey))
      throw new Error('Only a Stripe test-mode secret key is allowed');
  }

  async retrieve(subscriptionId: string): Promise<unknown> {
    if (!/^sub_[A-Za-z0-9_]{1,250}$/.test(subscriptionId))
      throw new Error('Invalid provider subscription identifier');
    const response = await fetch(
      'https://api.stripe.com/v1/subscriptions/' + subscriptionId,
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + this.secretKey,
          'Stripe-Version': '2025-09-30.clover',
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    );
    const contentType = response.headers.get('content-type');
    const body = response.body;
    if (response.status !== 200 || !contentType?.includes('application/json') || !body)
      throw new Error('Stripe test provider unavailable');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > 128 * 1024) throw new Error('Stripe response exceeded size limit');
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
}
