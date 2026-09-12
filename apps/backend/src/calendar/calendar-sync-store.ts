import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Dependencies } from '../dependencies';
import { CalendarBusyInterval, CalendarProviderConflict } from './calendar-provider';

export type CalendarFreshnessReason = 'fresh' | 'never_synced' | 'stale' | 'disconnected';

export interface CalendarBusySnapshot {
  connectionId: string;
  syncVersion: bigint;
  observedAt: string | null;
  fresh: boolean;
  reason: CalendarFreshnessReason;
  intervals: CalendarBusyInterval[];
}

interface ConnectionRow {
  status: 'connected' | 'disconnected' | 'reauth_required';
  syncVersion: bigint;
  lastSuccessAt: Date | null;
  freshnessLimitSeconds: number;
}

interface BusyRow {
  startsAt: Date;
  endsAt: Date;
}

export interface ReplaceCalendarBusySnapshotInput {
  tenantId: string;
  connectionId: string;
  expectedSyncVersion: bigint;
  observedAt: Date;
  syncToken: string | null;
  intervals: Array<{ startsAt: Date; endsAt: Date }>;
}

@Injectable()
export class CalendarSyncStore {
  constructor(private readonly deps: Dependencies) {}

  async replaceBusySnapshot(input: ReplaceCalendarBusySnapshotInput): Promise<bigint> {
    this.validateReplacement(input);
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      const [connection] = await tx.$queryRaw<ConnectionRow[]>(Prisma.sql`
        SELECT
          status,
          sync_version AS "syncVersion",
          last_success_at AS "lastSuccessAt",
          freshness_limit_seconds AS "freshnessLimitSeconds"
        FROM calendar_connections
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.connectionId}::uuid
        FOR UPDATE
      `);
      if (!connection) throw new CalendarProviderConflict();
      if (connection.status !== 'connected') throw new CalendarProviderConflict();
      if (connection.syncVersion !== input.expectedSyncVersion)
        throw new CalendarProviderConflict();

      const nextVersion = connection.syncVersion + 1n;
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM calendar_busy_intervals
        WHERE tenant_id=${input.tenantId}::uuid AND connection_id=${input.connectionId}::uuid
      `);
      for (const interval of input.intervals) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO calendar_busy_intervals (
            tenant_id, connection_id, id, starts_at, ends_at, sync_version, observed_at
          ) VALUES (
            ${input.tenantId}::uuid,
            ${input.connectionId}::uuid,
            ${randomUUID()}::uuid,
            ${interval.startsAt},
            ${interval.endsAt},
            ${nextVersion},
            ${input.observedAt}
          )
        `);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE calendar_connections
        SET
          sync_version=${nextVersion},
          sync_token=${input.syncToken},
          last_success_at=${input.observedAt},
          updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.connectionId}::uuid
      `);
      return nextVersion;
    });
  }

  async busySnapshot(input: {
    tenantId: string;
    connectionId: string;
    startsAt: Date;
    endsAt: Date;
    now?: Date;
  }): Promise<CalendarBusySnapshot> {
    if (!(input.endsAt > input.startsAt)) throw new CalendarProviderConflict();
    const now = input.now ?? new Date();
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      const [connection] = await tx.$queryRaw<ConnectionRow[]>(Prisma.sql`
        SELECT
          status,
          sync_version AS "syncVersion",
          last_success_at AS "lastSuccessAt",
          freshness_limit_seconds AS "freshnessLimitSeconds"
        FROM calendar_connections
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.connectionId}::uuid
      `);
      if (!connection) throw new CalendarProviderConflict();

      const reason = this.freshnessReason(connection, now);
      if (reason !== 'fresh') {
        return {
          connectionId: input.connectionId,
          syncVersion: connection.syncVersion,
          observedAt: connection.lastSuccessAt?.toISOString() ?? null,
          fresh: false,
          reason,
          intervals: [],
        };
      }

      const intervals = await tx.$queryRaw<BusyRow[]>(Prisma.sql`
        SELECT starts_at AS "startsAt", ends_at AS "endsAt"
        FROM calendar_busy_intervals
        WHERE tenant_id=${input.tenantId}::uuid
          AND connection_id=${input.connectionId}::uuid
          AND starts_at < ${input.endsAt}
          AND ends_at > ${input.startsAt}
          AND sync_version=${connection.syncVersion}
        ORDER BY starts_at ASC, ends_at ASC, id ASC
      `);
      return {
        connectionId: input.connectionId,
        syncVersion: connection.syncVersion,
        observedAt: connection.lastSuccessAt!.toISOString(),
        fresh: true,
        reason,
        intervals: intervals.map((interval) => ({
          startsAt: interval.startsAt.toISOString(),
          endsAt: interval.endsAt.toISOString(),
        })),
      };
    });
  }

  private freshnessReason(connection: ConnectionRow, now: Date): CalendarFreshnessReason {
    if (connection.status !== 'connected') return 'disconnected';
    if (!connection.lastSuccessAt) return 'never_synced';
    const ageMs = now.getTime() - connection.lastSuccessAt.getTime();
    if (ageMs < 0 || ageMs > connection.freshnessLimitSeconds * 1000) return 'stale';
    return 'fresh';
  }

  private validateReplacement(input: ReplaceCalendarBusySnapshotInput): void {
    if (input.expectedSyncVersion < 0n || Number.isNaN(input.observedAt.getTime())) {
      throw new CalendarProviderConflict();
    }
    for (const interval of input.intervals) {
      if (
        Number.isNaN(interval.startsAt.getTime()) ||
        Number.isNaN(interval.endsAt.getTime()) ||
        interval.endsAt <= interval.startsAt
      ) {
        throw new CalendarProviderConflict();
      }
    }
  }
}
