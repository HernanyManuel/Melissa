import { HttpException, Injectable } from '@nestjs/common';
import { Dependencies } from '../dependencies';
import { tokenHash } from './password';

@Injectable()
export class IdentityRateLimit {
  constructor(private readonly deps: Dependencies) {}
  async check(ip: string, email?: string): Promise<void> {
    for (const [key, limit] of [
      [`ip:${ip}`, 100],
      ...(email ? [[`email:${email.toLowerCase()}`, 20] as const] : []),
    ] as const) {
      const count = await this.deps.redis.eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
        1,
        `identity:${tokenHash(String(key))}`,
      );
      if (Number(count) > Number(limit)) throw new HttpException('RATE_LIMITED', 429);
    }
  }
}
