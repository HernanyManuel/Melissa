import { setTimeout as delay } from 'node:timers/promises';

// Listening on HTTP does not imply Redis is ready (offline queue is disabled).
export async function waitReady(base: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(base + '/health/ready', { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* Startup connection failures are expected until readiness. */
    }
    await delay(100);
  }
  throw new Error('Test API dependencies did not become ready');
}
