import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Response } from 'express';
import Redis from 'ioredis';
import { Dependencies } from '../dependencies';
import { AuthRequest } from '../identity/auth.guard';

export type OutboundOperation = 'store' | 'receipt';
export const OUTBOUND_LIMITS = { store: 30, receipt: 120 } as const;
export function outboundLimitKey(userId: string, operation: OutboundOperation) {
  return `outbound-limit:${operation}:${createHash('sha256').update(userId).digest('hex')}`;
}
const consume = `
local n=tonumber(redis.call('GET',KEYS[1]) or '0')
if not n or n<0 or n~=math.floor(n) then return redis.error_reply('invalid counter') end
local ttl=redis.call('PTTL',KEYS[1])
if n>=tonumber(ARGV[1]) then
  if ttl<0 then redis.call('PEXPIRE',KEYS[1],60000); ttl=60000 end
  return math.max(1,ttl)
end
redis.call('INCR',KEYS[1])
if ttl<0 then redis.call('PEXPIRE',KEYS[1],60000) end
return 0`;

export async function consumeOutboundLimit(
  redis: Redis,
  userId: string,
  operation: OutboundOperation,
) {
  try {
    const wait = await redis.eval(
      consume,
      1,
      outboundLimitKey(userId, operation),
      OUTBOUND_LIMITS[operation],
    );
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0)
      throw new Error('Invalid rate limit response');
    return Math.max(0, Math.ceil(wait / 1000));
  } catch {
    throw new ServiceUnavailableException();
  }
}

@Injectable()
export class OutboundRateLimitGuard implements CanActivate {
  constructor(private readonly deps: Dependencies) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const retry = await consumeOutboundLimit(
      this.deps.redis,
      req.actor.userId,
      req.method === 'POST' ? 'store' : 'receipt',
    );
    if (retry > 0) {
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retry));
      throw new HttpException('RATE_LIMITED', 429);
    }
    return true;
  }
}
