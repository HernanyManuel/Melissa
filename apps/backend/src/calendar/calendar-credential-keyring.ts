import { CalendarCredentialKeyring } from './calendar-credential-store';
import { SecretResolver, validateSecretReference } from '../secrets/secret-resolver';

export interface CalendarCredentialKeyReference {
  id: string;
  reference: string;
}

function validateKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId))
    throw new Error('Invalid calendar credential key configuration');
}

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
  previousKeys: readonly CalendarCredentialKeyReference[] = [],
): Promise<CalendarCredentialKeyring> {
  const configured = [{ id: keyId, reference: keyReference }, ...previousKeys];
  const ids = new Set<string>();
  for (const item of configured) {
    validateKeyId(item.id);
    if (ids.has(item.id)) throw new Error('Invalid calendar credential key configuration');
    ids.add(item.id);
  }

  const keys = new Map<string, Buffer>();
  try {
    for (const item of configured) {
      const reference = validateSecretReference(item.reference);
      keys.set(item.id, decodeKey(await secrets.resolve(reference)));
    }
  } catch {
    throw new Error('Calendar credential encryption key is unavailable');
  }

  const currentKey = keys.get(keyId);
  if (!currentKey) throw new Error('Calendar credential encryption key is unavailable');
  return {
    current: { id: keyId, key: Buffer.from(currentKey) },
    resolve: (requestedId) => {
      const key = keys.get(requestedId);
      return key ? Buffer.from(key) : null;
    },
  };
}
