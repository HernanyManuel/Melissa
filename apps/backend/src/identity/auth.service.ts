import { Injectable, Inject, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { CONFIG, Configuration } from '../config';
import { Dependencies } from '../dependencies';
import { log } from '../logging';
import { IdentityMail } from './mail';
import { passwordHash, passwordMatches, opaqueToken, tokenHash } from './password';
import { RegisterDto } from './dto';

export interface Actor {
  userId: string;
  sessionId: string;
}
@Injectable()
export class AuthService {
  private readonly jwt: JwtService;
  private readonly dummy = passwordHash(opaqueToken());
  constructor(
    private readonly deps: Dependencies,
    private readonly mail: IdentityMail,
    @Inject(CONFIG) config: Configuration,
  ) {
    this.jwt = new JwtService({
      secret: config.JWT_SECRET ?? randomBytes(48).toString('hex'),
      signOptions: {
        algorithm: 'HS256',
        issuer: 'melissa',
        audience: 'melissa-app',
        expiresIn: '10m',
      },
      verifyOptions: { algorithms: ['HS256'], issuer: 'melissa', audience: 'melissa-app' },
    });
  }
  async register(input: RegisterDto): Promise<void> {
    const email = input.email.toLowerCase().trim();
    const encoded = await passwordHash(input.password);
    let user;
    try {
      user = await this.deps.db.user.create({
        data: {
          email,
          name: input.name.trim(),
          passwordHash: encoded,
          termsVersion: 'development-2026-09-02',
          termsAcceptedAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
    await this.issue(user.id, email, 'verify');
  }
  async issue(userId: string, email: string, purpose: 'verify' | 'reset'): Promise<void> {
    const token = opaqueToken();
    await this.deps.db.identityToken.create({
      data: {
        hash: tokenHash(token),
        userId,
        purpose,
        expiresAt: new Date(Date.now() + (purpose === 'reset' ? 30 : 1440) * 60000),
      },
    });
    try {
      await this.mail.send(email, purpose, token);
    } catch {
      log.warn({ event: 'identity_email_failed' });
    }
  }
  async requestToken(email: string, purpose: 'verify' | 'reset'): Promise<void> {
    const user = await this.deps.db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (user && (purpose === 'reset' || !user.verifiedAt))
      await this.issue(user.id, user.email, purpose);
  }
  async consume(token: string, purpose: 'verify' | 'reset', password?: string): Promise<void> {
    const encoded = password ? await passwordHash(password) : undefined;
    await this.deps.db.$transaction(async (tx) => {
      const item = await tx.identityToken.findUnique({ where: { hash: tokenHash(token) } });
      if (!item || item.purpose !== purpose || item.usedAt || item.expiresAt <= new Date())
        throw new BadRequestException();
      // Lock user first: serialize password reset and login/session creation.
      await tx.$queryRaw`SELECT id FROM users WHERE id=${item.userId}::uuid FOR UPDATE`;
      const consumed = await tx.identityToken.updateMany({
        where: { hash: item.hash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new BadRequestException();
      await tx.user.update({
        where: { id: item.userId },
        data: purpose === 'verify' ? { verifiedAt: new Date() } : { passwordHash: encoded },
      });
      if (purpose === 'reset') {
        await tx.session.updateMany({
          where: { userId: item.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.identityToken.updateMany({
          where: { userId: item.userId, purpose: 'reset', usedAt: null },
          data: { usedAt: new Date() },
        });
      }
    });
  }
  async login(email: string, password: string) {
    const user = await this.deps.db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    const valid = await passwordMatches(user?.passwordHash ?? (await this.dummy), password);
    if (!user || !valid || !user.verifiedAt) throw new UnauthorizedException();
    const refresh = opaqueToken();
    const session = await this.deps.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.passwordHash !== user.passwordHash) throw new UnauthorizedException();
      return tx.session.create({
        data: {
          userId: user.id,
          expiresAt: new Date(Date.now() + 30 * 86400000),
          refreshTokens: { create: { hash: tokenHash(refresh) } },
        },
      });
    });
    return { access_token: this.jwt.sign({ sub: user.id, sid: session.id }), refresh };
  }
  async refresh(token: string) {
    const next = opaqueToken();
    const session = await this.deps.db.$transaction(async (tx) => {
      const old = await tx.refreshToken.findUnique({ where: { hash: tokenHash(token) } });
      if (!old) return null;
      await tx.$queryRaw`SELECT id FROM sessions WHERE id=${old.sessionId}::uuid FOR UPDATE`;
      const current = await tx.session.findUniqueOrThrow({ where: { id: old.sessionId } });
      const freshOld = await tx.refreshToken.findUniqueOrThrow({ where: { hash: old.hash } });
      if (freshOld.usedAt) {
        await tx.session.update({ where: { id: current.id }, data: { revokedAt: new Date() } });
        return null; // commit replay revocation before returning HTTP 401
      }
      if (current.revokedAt || current.expiresAt <= new Date()) return null;
      await tx.refreshToken.update({ where: { hash: old.hash }, data: { usedAt: new Date() } });
      await tx.refreshToken.create({ data: { hash: tokenHash(next), sessionId: current.id } });
      return current;
    });
    if (!session) throw new UnauthorizedException();
    return { access_token: this.jwt.sign({ sub: session.userId, sid: session.id }), refresh: next };
  }
  async authenticate(header?: string): Promise<Actor> {
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    let payload: { sub?: string; sid?: string };
    try {
      payload = this.jwt.verify(header.slice(7));
    } catch {
      throw new UnauthorizedException();
    }
    if (!payload.sid || !payload.sub) throw new UnauthorizedException();
    const session = await this.deps.db.session.findUnique({ where: { id: payload.sid } });
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    )
      throw new UnauthorizedException();
    return { userId: session.userId, sessionId: session.id };
  }
  async logout(actor: Actor): Promise<void> {
    await this.deps.db.session.update({
      where: { id: actor.sessionId },
      data: { revokedAt: new Date() },
    });
  }
  me(actor: Actor) {
    return this.deps.db.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { id: true, email: true, name: true, verifiedAt: true },
    });
  }
}
