import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Dependencies } from '../dependencies';
import { TenantService } from '../tenancy/tenant.service';
import {
  CalendarCredentialStore,
  calendarCredentialReference,
} from './calendar-credential-store';
import { CalendarOAuthStateService } from './calendar-oauth-state.service';
import {
  GoogleOAuthTokenClient,
  GoogleOAuthUnavailable,
} from './google-oauth-token-client';

export interface GoogleCalendarOAuthCompletion {
  connectionId: string;
  calendarRef: 'primary';
  status: 'connected';
}

export class GoogleCalendarOAuthService {
  constructor(
    deps: Dependencies,
    private readonly tenants: TenantService,
    private readonly states: CalendarOAuthStateService,
    private readonly tokens: GoogleOAuthTokenClient,
    private readonly credentials: CalendarCredentialStore,
  ) {
    void deps;
  }

  async complete(
    state: string,
    code: string,
  ): Promise<GoogleCalendarOAuthCompletion> {
    const consumed = await this.states.consume(state);
    const credential = await this.tokens.exchange({
      code,
      redirectUri: consumed.redirectUri,
      pkceVerifier: consumed.pkceVerifier,
    });
    if (!credential.refreshToken) throw new GoogleOAuthUnavailable();

    const actor = { userId: consumed.userId, sessionId: consumed.sessionId };
    return this.tenants.scoped(
      actor,
      consumed.tenantId,
      'integration:write',
      async (tx) => {
        const [existing] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id::text AS id
          FROM calendar_connections
          WHERE tenant_id=${consumed.tenantId}::uuid
            AND provider='google'
            AND calendar_ref='primary'
          FOR UPDATE
        `);
        const connectionId = existing?.id ?? randomUUID();
        const reference = calendarCredentialReference(consumed.tenantId, connectionId);

        if (existing) {
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM calendar_busy_intervals
            WHERE tenant_id=${consumed.tenantId}::uuid
              AND connection_id=${connectionId}::uuid
          `);
          await tx.$executeRaw(Prisma.sql`
            UPDATE calendar_connections
            SET
              credential_ref=${reference},
              status='connected',
              sync_token=NULL,
              sync_version=sync_version + 1,
              last_success_at=NULL,
              coverage_starts_at=NULL,
              coverage_ends_at=NULL,
              updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=${consumed.tenantId}::uuid
              AND id=${connectionId}::uuid
          `);
        } else {
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO calendar_connections (
              tenant_id, id, provider, calendar_ref, credential_ref, status
            ) VALUES (
              ${consumed.tenantId}::uuid,
              ${connectionId}::uuid,
              'google',
              'primary',
              ${reference},
              'connected'
            )
          `);
        }

        await this.credentials.putInTransaction(tx, {
          tenantId: consumed.tenantId,
          connectionId,
          credential,
        });
        await this.tenants.audit(
          tx,
          actor,
          consumed.tenantId,
          'calendar.google_connected',
          connectionId,
        );

        return { connectionId, calendarRef: 'primary', status: 'connected' };
      },
    );
  }
}
