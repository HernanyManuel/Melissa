import { Configuration, ParsedQuarantineKey, whatsappPreviousQuarantineKeys } from '../config';
import { QuarantineKey } from './whatsapp-quarantine';

export interface QuarantineKeyring {
  current?: QuarantineKey;
  resolve(keyId: string): Buffer | null;
}

/** The current key encrypts new payloads; previous keys are read-only for bounded rotation. */
export function createQuarantineKeyring(config: Configuration): QuarantineKeyring {
  const previous = whatsappPreviousQuarantineKeys(config.WHATSAPP_QUARANTINE_PREVIOUS_KEYS);
  const current =
    config.WHATSAPP_QUARANTINE_KEY && config.WHATSAPP_QUARANTINE_KEY_ID
      ? {
          id: config.WHATSAPP_QUARANTINE_KEY_ID,
          key: Buffer.from(config.WHATSAPP_QUARANTINE_KEY, 'base64'),
        }
      : undefined;
  const keys = new Map<string, Buffer>(
    [...previous, ...(current ? [current] : [])].map((item: ParsedQuarantineKey) => [
      item.id,
      Buffer.from(item.key),
    ]),
  );
  return {
    current: current ? { id: current.id, key: Buffer.from(current.key) } : undefined,
    resolve: (keyId) => {
      const key = keys.get(keyId);
      return key ? Buffer.from(key) : null;
    },
  };
}
