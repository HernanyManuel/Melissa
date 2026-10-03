import { CalendarCredentialKeyring } from './calendar-credential-store';
import { SecretResolver, validateSecretReference } from '../secrets/secret-resolver';

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value)
    throw new Error('Invalid calendar credential encryption key');
  return key;
}

export async function createCalendarCredentialKeyring(
  secrets: SecretResolver,
  keyId: string,
  keyReference: string,
): Promise<CalendarCredentialKeyring> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId))
    throw new Error('Invalid calendar credential key configuration');
  let key: Buffer;
  try {
    key = decodeKey(await secrets.resolve(validateSecretReference(keyReference)));
  } catch {
    throw new Error('Calendar credential encryption key is unavailable');
  }
  const current = { id: keyId, key };
  return {
    current,
    resolve: (requestedId) => (requestedId === keyId ? Buffer.from(key) : null),
  };
}
