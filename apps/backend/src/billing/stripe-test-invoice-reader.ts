import { stripeTestSubscriptionSnapshot } from './stripe-reconciler';

// Stripe TEST invoice API is a source of payment-state observations only.
// "paid" is not proof of irrevocable settlement or entitlement activation.
const INVOICE_ID = /^in_[A-Za-z0-9_]{1,250}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,250}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,250}$/;

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1000000000 &&
    value < 253402300800
    ? value
    : null;
}

export interface PaidTestInvoiceSnapshot {
  id: string;
  customer: string;
  subscription: string;
  currency: string;
  amountPaidMinor: bigint;
  paidAt: Date;
}

// Strict initial evidence: no $0/trial/out-of-band invoices, no manual
// invoice without a parent subscription. Invoice line pricing is NOT used
// as a billing policy; a fresh subscription price check happens separately.
// prettier-ignore
export function stripeTestPaidInvoiceSnapshot(value: unknown): PaidTestInvoiceSnapshot | null {
  const invoice = obj(value);
  const details = obj(obj(invoice?.parent)?.subscription_details);
  const paidAt = timestamp(obj(invoice?.status_transitions)?.paid_at);
  if (!invoice || invoice.object !== 'invoice' || invoice.livemode !== false ||
    typeof invoice.id !== 'string' || !INVOICE_ID.test(invoice.id) ||
    invoice.status !== 'paid' || invoice.paid !== true ||
    invoice.paid_out_of_band === true ||
    invoice.collection_method !== 'charge_automatically' ||
    typeof invoice.customer !== 'string' || !CUSTOMER_ID.test(invoice.customer) ||
    typeof details?.subscription !== 'string' || !SUBSCRIPTION_ID.test(details.subscription) ||
    typeof invoice.currency !== 'string' || !/^[a-z]{3}$/.test(invoice.currency) ||
    typeof invoice.amount_paid !== 'number' || !Number.isSafeInteger(invoice.amount_paid) ||
    invoice.amount_paid <= 0 || invoice.amount_paid > 100_000_000_000 ||
    invoice.total !== invoice.amount_paid || invoice.amount_remaining !== 0 ||
    paidAt === null)
    return null;
  return {
    id: invoice.id,
    customer: invoice.customer,
    subscription: details.subscription,
    currency: invoice.currency.toUpperCase(),
    amountPaidMinor: BigInt(invoice.amount_paid),
    paidAt: new Date(paidAt * 1000),
  };
}

export interface StripeInvoiceEvidenceProvider {
  retrieveInvoice(id: string): Promise<unknown>;
  retrieveSubscription(id: string): Promise<unknown>;
}

export class StripeTestInvoiceReader implements StripeInvoiceEvidenceProvider {
  constructor(
    private readonly key: string,
    private readonly http: typeof fetch = fetch,
  ) {
    if (!/^sk_test_[A-Za-z0-9_-]{16,256}$/.test(key))
      throw new Error('Stripe invoice evidence requires test credentials');
  }

  private async read(url: string): Promise<unknown> {
    const response = await this.http('https://api.stripe.com' + url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + this.key,
        'Stripe-Version': '2025-09-30.clover',
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('application/json') ||
      !response.body
    )
      throw new Error('Stripe test evidence provider unavailable');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 128 * 1024) throw new Error('Stripe invoice response too large');
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async retrieveInvoice(id: string): Promise<unknown> {
    if (!INVOICE_ID.test(id)) throw new Error('Invalid Stripe test invoice ID');
    return this.read('/v1/invoices/' + id);
  }

  async retrieveSubscription(id: string): Promise<unknown> {
    if (!SUBSCRIPTION_ID.test(id)) throw new Error('Invalid Stripe test subscription ID');
    return this.read('/v1/subscriptions/' + id);
  }
}

// Used by the verifier after invoice validation; kept here so the future
// billing authority must explicitly re-evaluate signed invoices and pricing.
export { stripeTestSubscriptionSnapshot };
