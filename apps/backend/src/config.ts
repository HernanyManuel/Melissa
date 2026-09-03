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
  if (result.data.NODE_ENV === 'production') {
    // P1 deliberately has no authenticated product API or deployment profile.
    throw new Error(
      'Production is disabled until identity, isolation and release gates are complete.',
    );
  }
  return result.data;
}
