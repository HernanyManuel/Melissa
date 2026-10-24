// ADR-118: bounded cursor walk; never turn a partial Stripe list into an
// apparently complete financial observation. All cursors come from Stripe
// resource IDs, not client parameters or Stripe metadata.
export interface StripeListPage {
  object: 'list';
  data: unknown[];
  has_more: boolean;
}
const CURSOR = /^[a-z][A-Za-z0-9_]{2,254}$/;
export const MAX_STRIPE_LIST_ITEMS = 100;
export const MAX_STRIPE_LIST_PAGES = 3;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function readBoundedStripeList(
  fetchPage: (cursor: string | null) => Promise<unknown>,
): Promise<StripeListPage> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const collected: unknown[] = [];
  for (let page = 0; page < MAX_STRIPE_LIST_PAGES; page++) {
    const response = record(await fetchPage(cursor));
    if (
      response?.object !== 'list' ||
      !Array.isArray(response.data) ||
      response.data.length > 100 ||
      typeof response.has_more !== 'boolean'
    )
      throw new Error('Malformed Stripe TEST list');
    const data = response.data as unknown[];
    if (response.has_more && data.length === 0) throw new Error('Non-advancing Stripe TEST cursor');
    for (const item of data) {
      const entry = record(item);
      if (!entry || typeof entry.id !== 'string' || !CURSOR.test(entry.id) || seen.has(entry.id))
        throw new Error('Malformed or repeated Stripe TEST ID');
      seen.add(entry.id);
      if (collected.length === MAX_STRIPE_LIST_ITEMS)
        return { object: 'list', data: collected, has_more: true };
      collected.push(item);
    }
    if (!response.has_more) return { object: 'list', data: collected, has_more: false };
    const last = record(data[data.length - 1])?.id;
    if (typeof last !== 'string' || last === cursor) throw new Error('Invalid Stripe TEST cursor');
    cursor = last;
    if (collected.length === MAX_STRIPE_LIST_ITEMS || page === MAX_STRIPE_LIST_PAGES - 1)
      return { object: 'list', data: collected, has_more: true };
  }
  return { object: 'list', data: collected, has_more: true };
}
