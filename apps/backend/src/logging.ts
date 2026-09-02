import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['password', 'token', 'secret', 'authorization', 'cookie'],
    censor: '[REDACTED]',
  },
  base: { service: 'melissa' },
});
