import { BadRequestException } from '@nestjs/common';
import { Prisma, TenantRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { Dependencies } from '../dependencies';
import { Actor } from '../identity/auth.service';
import { tokenHash } from '../identity/password';
import { allows } from '../tenancy/permissions';
import { TenantService } from '../tenancy/tenant.service';

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStateRow {
  stateHash: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  redirectUri: string;
  pkceVerifier: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface CalendarOAuthStart {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  expiresAt: string;
}

export interface ConsumedCalendarOAuthState {
  tenantId: string;
  userId: string;
  sessionId: string;
  redirectUri: string;
  pkceVerifier: string;
}

function normalizeRedirectUri(value: string): string {
  if (!value || value !== value.trim() || value.length > 2048) throw new BadRequestException();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException();
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new BadRequestException();
  return url.toString();
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export class CalendarOAuthStateService {
  private readonly allowedRedirects: ReadonlySet<string>;

  constructor(
    private readonly deps: Dependencies,
    private readonly tenants: TenantService,
    allowedRedirectUris: readonly string[],
  ) {
    this.allowedRedirects = new Set(allowedRedirectUris.map(normalizeRedirectUri));
  }

  async begin(actor: Actor, tenantId: string, redirectUri: string): Promise<CalendarOAuthStart> {
    const normalizedRedirect = normalizeRedirectUri(redirectUri);
    if (!this.allowedRedirects.has(normalizedRedirect)) throw new BadRequestException();
    const state = randomBytes(32).toString('base64url');
    const stateHash = tokenHash(state);
    const verifier = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);

    await this.tenants.scoped(actor, tenantId, 'integration:write', async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM calendar_oauth_states
        WHERE tenant_id=${tenantId}::uuid
          AND user_id=${actor.userId}::uuid
          AND session_id=${actor.sessionId}::uuid
          AND used_at IS NULL
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO calendar_oauth_states (
          state_hash, tenant_id, user_id, session_id, redirect_uri, pkce_verifier, expires_at
        ) VALUES (
          ${stateHash}, ${tenantId}::uuid, ${actor.userId}::uuid, ${actor.sessionId}::uuid,
          ${normalizedRedirect}, ${verifier}, ${expiresAt}
        )
      `);
      await this.tenants.audit(tx, actor, tenantId, 'calendar.oauth_started', tenantId);
    });

    return {
      state,
      codeChallenge: pkceChallenge(verifier),
      codeChallengeMethod: 'S256',
      redirectUri: normalizedRedirect,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async consume(state: string): Promise<ConsumedCalendarOAuthState> {
    if (!STATE_PATTERN.test(state)) throw new BadRequestException();
    const stateHash = tokenHash(state);
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.oauth_state_hash', ${stateHash}, true)`;
      const [row] = await tx.$queryRaw<OAuthStateRow[]>(Prisma.sql`
        SELECT
          state_hash AS "stateHash",
          tenant_id::text AS "tenantId",
          user_id::text AS "userId",
          session_id::text AS "sessionId",
          redirect_uri AS "redirectUri",
          pkce_verifier AS "pkceVerifier",
          expires_at AS "expiresAt",
          used_at AS "usedAt"
        FROM calendar_oauth_states
        WHERE state_hash=${stateHash}
        FOR UPDATE
      `);
      if (!row || row.usedAt || row.expiresAt <= new Date()) throw new BadRequestException();

      const session = await tx.session.findUnique({ where: { id: row.sessionId } });
      if (
        !session ||
        session.userId !== row.userId ||
        session.revokedAt ||
        session.expiresAt <= new Date()
      )
        throw new BadRequestException();

      await tx.$executeRaw`SELECT set_config('app.actor_id', ${row.userId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${row.tenantId}, true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${row.tenantId}::uuid FOR UPDATE`;
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: row.tenantId, userId: row.userId } },
      });
      if (!membership?.active || !allows(membership.role as TenantRole, 'integration:write'))
        throw new BadRequestException();

      const consumed = await tx.$queryRaw<Array<{ stateHash: string }>>(Prisma.sql`
        UPDATE calendar_oauth_states
        SET used_at=CURRENT_TIMESTAMP
        WHERE state_hash=${stateHash}
          AND used_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
        RETURNING state_hash AS "stateHash"
      `);
      if (consumed.length !== 1) throw new BadRequestException();
      await this.tenants.audit(
        tx,
        { userId: row.userId, sessionId: row.sessionId },
        row.tenantId,
        'calendar.oauth_state_consumed',
        row.tenantId,
      );

      return {
        tenantId: row.tenantId,
        userId: row.userId,
        sessionId: row.sessionId,
        redirectUri: row.redirectUri,
        pkceVerifier: row.pkceVerifier,
      };
    });
  }
}
