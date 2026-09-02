import { hash, verify, argon2id } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

export const passwordHash = (password: string): Promise<string> =>
  hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const passwordMatches = (encoded: string, password: string): Promise<boolean> =>
  verify(encoded, password);
export const opaqueToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
