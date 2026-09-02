import type { ConnectionOptions } from 'bullmq';

// Pass connection options, not a client from a different Redis dependency version.
// BullMQ owns and closes the clients it creates from these options.
export function queueConnection(value: string): ConnectionOptions {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, '') || '0';
  if (!['redis:', 'rediss:'].includes(url.protocol) || !/^\d+$/.test(database)) {
    throw new Error('Invalid Redis connection settings');
  }
  const db = Number(database);
  if (!Number.isSafeInteger(db)) throw new Error('Invalid Redis database');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    maxRetriesPerRequest: null,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
