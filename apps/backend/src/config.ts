import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
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
  if (result.data.NODE_ENV === 'production') {
    // P1 deliberately has no authenticated product API or deployment profile.
    throw new Error(
      'Production is disabled until identity, isolation and release gates are complete.',
    );
  }
  return result.data;
}
