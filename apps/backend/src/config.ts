import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(48).optional(),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MESSAGE_DEBOUNCE_MS: z.coerce.number().int().min(100).max(2000).default(1500),
  WHATSAPP_WEBHOOK_ENABLED: z.enum(['false', 'true']).default('false'),
  WHATSAPP_INTEGRATION_KEY: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional()
    .or(z.literal('')),
  WHATSAPP_APP_SECRET: z.string().max(1024).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().max(1024).optional(),
  WHATSAPP_WEBHOOK_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(300),
  WHATSAPP_MEDIA_ENABLED: z.enum(['false', 'true']).default('false'),
  WHATSAPP_MEDIA_ACCESS_TOKEN: z.string().max(4096).optional(),
  WHATSAPP_MEDIA_API_VERSION: z
    .string()
    .regex(/^v[1-9][0-9]*\.[0-9]+$/)
    .optional()
    .or(z.literal('')),
  WHATSAPP_MEDIA_DOWNLOAD_HOSTS: z.string().max(2048).optional(),
  WHATSAPP_QUARANTINE_KEY_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional()
    .or(z.literal('')),
  WHATSAPP_QUARANTINE_KEY: z
    .string()
    .refine(
      (value) =>
        !value ||
        (Buffer.from(value, 'base64').length === 32 &&
          Buffer.from(value, 'base64').toString('base64') === value),
    )
    .optional(),
  WHATSAPP_QUARANTINE_PREVIOUS_KEYS: z.string().max(16384).optional(),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:/.test(value)),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => /^rediss?:/.test(value)),
  CORS_ORIGIN: z.string().url().default('http://localhost:8080'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export type Configuration = z.infer<typeof schema>;
export const CONFIG = Symbol('CONFIG');

const MEDIA_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function whatsappMediaHosts(value: string | undefined): string[] {
  if (!value) return [];
  const hosts = value.split(',');
  if (
    hosts.some(
      (host) => host !== host.trim() || host !== host.toLowerCase() || !MEDIA_HOST.test(host),
    )
  )
    throw new Error('Invalid environment fields: WHATSAPP_MEDIA_DOWNLOAD_HOSTS');
  return [...new Set(hosts)];
}

export interface ParsedQuarantineKey {
  id: string;
  key: Buffer;
}

function decodeQuarantineKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new Error('Invalid environment fields: WHATSAPP_QUARANTINE_PREVIOUS_KEYS');
  return key;
}

export function whatsappPreviousQuarantineKeys(value: string | undefined): ParsedQuarantineKey[] {
  if (!value) return [];
  const entries = value.split(',');
  if (entries.length > 4) throw new Error('Too many previous quarantine keys');
  const seen = new Set<string>();
  return entries.map((entry) => {
    const separator = entry.indexOf('=');
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (
      separator < 1 ||
      entry !== entry.trim() ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      seen.has(id)
    )
      throw new Error('Invalid environment fields: WHATSAPP_QUARANTINE_PREVIOUS_KEYS');
    seen.add(id);
    return { id, key: decodeQuarantineKey(encoded) };
  });
}

export function parseConfig(input: Record<string, unknown>): Configuration {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Never include values (URLs may contain credentials) in the error.
    throw new Error(
      'Invalid environment fields: ' +
        result.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  }
  if (
    result.data.WHATSAPP_WEBHOOK_ENABLED === 'true' &&
    (!result.data.WHATSAPP_INTEGRATION_KEY ||
      (result.data.WHATSAPP_APP_SECRET?.trim().length ?? 0) < 16 ||
      (result.data.WHATSAPP_VERIFY_TOKEN?.trim().length ?? 0) < 16)
  )
    throw new Error(
      'WhatsApp webhook requires server-side integration key, app secret and verify token',
    );
  if (!!result.data.WHATSAPP_QUARANTINE_KEY !== !!result.data.WHATSAPP_QUARANTINE_KEY_ID)
    throw new Error('Quarantine requires both key and key ID');
  const previousKeys = whatsappPreviousQuarantineKeys(
    result.data.WHATSAPP_QUARANTINE_PREVIOUS_KEYS,
  );
  if (previousKeys.length && !result.data.WHATSAPP_QUARANTINE_KEY)
    throw new Error('Previous quarantine keys require a current write key');
  if (result.data.WHATSAPP_QUARANTINE_KEY && result.data.WHATSAPP_QUARANTINE_KEY_ID) {
    const current = decodeQuarantineKey(result.data.WHATSAPP_QUARANTINE_KEY);
    if (
      previousKeys.some(
        (item) => item.id === result.data.WHATSAPP_QUARANTINE_KEY_ID || item.key.equals(current),
      ) ||
      previousKeys.some((item, index) =>
        previousKeys.slice(index + 1).some((other) => other.key.equals(item.key)),
      )
    )
      throw new Error('Quarantine key IDs and material must be unique');
  }
  const mediaHosts = whatsappMediaHosts(result.data.WHATSAPP_MEDIA_DOWNLOAD_HOSTS);
  if (
    result.data.WHATSAPP_MEDIA_ENABLED === 'true' &&
    ((result.data.WHATSAPP_MEDIA_ACCESS_TOKEN?.trim().length ?? 0) < 16 ||
      result.data.WHATSAPP_MEDIA_ACCESS_TOKEN !== result.data.WHATSAPP_MEDIA_ACCESS_TOKEN?.trim() ||
      !result.data.WHATSAPP_MEDIA_API_VERSION ||
      mediaHosts.length === 0)
  )
    throw new Error(
      'WhatsApp media requires server-side access token, API version and download hosts',
    );
  if (result.data.NODE_ENV === 'production') {
    // P1 deliberately has no authenticated product API or deployment profile.
    throw new Error(
      'Production is disabled until identity, isolation and release gates are complete.',
    );
  }
  return result.data;
}
