import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { CalendarProviderConflict, CalendarProviderInvalidRequest } from './calendar-provider';
import { CalendarProviderRegistry } from './calendar-provider-registry';
import { CalendarSyncStore } from './calendar-sync-store';

interface SyncConnectionRow {
  provider: string;
  calendarRef: string;
  credentialRef: string | null;
  status: 'connected' | 'disconnected' | 'reauth_required';
  syncVersion: bigint;
  syncToken: string | null;
}

export interface CalendarSyncBusyInput {
  tenantId: string;
  connectionId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface CalendarSyncBusyResult {
  syncVersion: bigint;
  observedAt: string;
  intervalCount: number;
}

export class CalendarSyncService {
  constructor(
    private readonly deps: Dependencies,
    private readonly providers: CalendarProviderRegistry,
    private readonly store = new CalendarSyncStore(deps),
  ) {}

  async syncBusy(input: CalendarSyncBusyInput): Promise<CalendarSyncBusyResult> {
    this.validateInput(input);
    const connection = await this.readConnection(input.tenantId, input.connectionId);
    if (connection.status !== 'connected' || !connection.credentialRef)
      throw new CalendarProviderConflict();

    const provider = this.providers.get(connection.provider);
    const result = await provider.busy({
      connection: {
        connectionId: input.connectionId,
        calendarRef: connection.calendarRef,
        credentialRef: connection.credentialRef,
      },
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      syncToken: connection.syncToken,
    });
    const observedAt = new Date(result.observedAt);
    const intervals = result.intervals.map((interval) => ({
      startsAt: new Date(interval.startsAt),
      endsAt: new Date(interval.endsAt),
    }));
    const syncVersion = await this.store.replaceBusySnapshot({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      expectedSyncVersion: connection.syncVersion,
      observedAt,
      syncToken: result.syncToken,
      intervals,
    });
    return {
      syncVersion,
      observedAt: observedAt.toISOString(),
      intervalCount: intervals.length,
    };
  }

  private async readConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<SyncConnectionRow> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const [connection] = await tx.$queryRaw<SyncConnectionRow[]>(Prisma.sql`
        SELECT
          provider,
          calendar_ref AS "calendarRef",
          credential_ref AS "credentialRef",
          status,
          sync_version AS "syncVersion",
          sync_token AS "syncToken"
        FROM calendar_connections
        WHERE tenant_id=${tenantId}::uuid AND id=${connectionId}::uuid
      `);
      if (!connection) throw new CalendarProviderConflict();
      return connection;
    });
  }

  private validateInput(input: CalendarSyncBusyInput): void {
    if (
      !isUUID(input.tenantId) ||
      !isUUID(input.connectionId) ||
      Number.isNaN(input.startsAt.getTime()) ||
      Number.isNaN(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new CalendarProviderInvalidRequest();
    }
  }
}
