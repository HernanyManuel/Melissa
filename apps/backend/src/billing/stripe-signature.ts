import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe signs `${timestamp}.${raw UTF-8 body}` with HMAC-SHA256.
// Never sign JSON re-serialization or trust event identifiers before this.
// prettier-ignore
export function verifyStripeSignature(
  body: Buffer,
  signature: string | string[] | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 256 * 1024 ||
      typeof signature !== 'string' || signature.length > 2048)
    return false;
  const parts = signature.split(',');
  if (parts.length > 16) return false;
  const timestamps = parts.filter((x) => x.startsWith('t='));
  const signatures = parts.filter((x) => x.startsWith('v1='));
  if (timestamps.length !== 1 || signatures.length < 1 || signatures.length > 8)
    return false;
  const timestamp = timestamps[0]!.slice(2);
  if (!/^\d{10,11}$/.test(timestamp)) return false;
  const signedAt = Number(timestamp);
  if (!Number.isSafeInteger(signedAt) || Math.abs(nowSeconds - signedAt) > 300)
    return false;
  const message = Buffer.concat([Buffer.from(timestamp + '.'), body]);
  const expected = createHmac('sha256', secret).update(message).digest();
  let match = false;
  for (const item of signatures) {
    const hex = item.slice(3);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) continue;
    const supplied = Buffer.from(hex, 'hex');
    match = timingSafeEqual(expected, supplied) || match;
  }
  return match;
}
