import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const renewScript =
  "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";
const releaseScript =
  "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

export class ConversationLock {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs = 15000,
  ) {
    if (ttlMs < 300 || !Number.isInteger(ttlMs)) throw new Error('Invalid lock TTL');
  }

  async run(
    key: string,
    work: (assertOwned: () => Promise<void>) => Promise<void>,
  ): Promise<boolean> {
    const token = randomUUID();
    if ((await this.redis.set(key, token, 'PX', this.ttlMs, 'NX')) !== 'OK') return false;
    let lost = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewal = Promise.resolve();
    const renew = async () => {
      try {
        if ((await this.redis.eval(renewScript, 1, key, token, this.ttlMs)) !== 1) lost = true;
      } catch {
        lost = true;
      }
      if (!stopped && !lost)
        timer = setTimeout(
          () => {
            renewal = renew();
          },
          Math.floor(this.ttlMs / 3),
        );
    };
    const assertOwned = async () => {
      if (lost || (await this.redis.get(key)) !== token) throw new Error('Conversation lease lost');
    };
    timer = setTimeout(
      () => {
        renewal = renew();
      },
      Math.floor(this.ttlMs / 3),
    );
    try {
      await work(assertOwned);
      return true;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await renewal;
      // Failure to release expires naturally; never delete a successor's lease.
      await this.redis.eval(releaseScript, 1, key, token).catch(() => undefined);
    }
  }
}
