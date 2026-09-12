import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  CalendarBookingCancellation,
  CalendarBookingMutation,
  CalendarBusyRequest,
  CalendarBusyResult,
  CalendarExternalEvent,
  CalendarProvider,
  CalendarProviderConflict,
} from '../src/calendar/calendar-provider';
import { CalendarProviderRegistry } from '../src/calendar/calendar-provider-registry';
import { CalendarSyncService } from '../src/calendar/calendar-sync-service';
import { CalendarSyncStore } from '../src/calendar/calendar-sync-store';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

class ControlledCalendarProvider implements CalendarProvider {
  readonly providerKey = 'mock';
  readonly seenSyncTokens: Array<string | null> = [];
  private callCount = 0;
  private pause:
    | {
        entered: () => void;
        wait: Promise<void>;
      }
    | undefined;

  pauseNext(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pause = { entered, wait };
    return { entered: enteredPromise, release };
  }

  async busy(request: CalendarBusyRequest): Promise<CalendarBusyResult> {
    this.seenSyncTokens.push(request.syncToken);
    this.callCount += 1;
    const paused = this.pause;
    this.pause = undefined;
    if (paused) {
      paused.entered();
      await paused.wait;
    }
    return {
      observedAt: new Date().toISOString(),
      intervals: [
        {
          startsAt: request.startsAt,
          endsAt: new Date(new Date(request.startsAt).getTime() + 30 * 60_000).toISOString(),
        },
      ],
      syncToken: `checkpoint-${this.callCount}`,
    };
  }

  async upsertBooking(_request: CalendarBookingMutation): Promise<CalendarExternalEvent> {
    throw new Error('Not implemented in sync fixture');
  }

  async cancelBooking(_request: CalendarBookingCancellation): Promise<CalendarExternalEvent> {
    throw new Error('Not implemented in sync fixture');
  }
}

test(
  'calendar sync orchestration carries checkpoints and rejects a late stale publication',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'calendar sync service integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenantId = randomUUID();
    const connectionId = randomUUID();
    const provider = new ControlledCalendarProvider();
    const providers = new CalendarProviderRegistry();
    providers.register(provider);
    const store = new CalendarSyncStore(deps);
    const service = new CalendarSyncService(deps, providers, store);
    const startsAt = new Date('2030-01-01T09:00:00Z');
    const endsAt = new Date('2030-01-01T11:00:00Z');

    try {
      await admin.tenant.create({
        data: {
          id: tenantId,
          name: 'Calendar sync service fixture',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
        },
      });
      await admin.$executeRaw`
        INSERT INTO calendar_connections (
          tenant_id, id, provider, calendar_ref, credential_ref, status, freshness_limit_seconds
        ) VALUES (
          ${tenantId}::uuid, ${connectionId}::uuid, 'mock', 'mock:orchestrated',
          'secret://calendar/mock', 'connected', 60
        )
      `;

      const first = await service.syncBusy({ tenantId, connectionId, startsAt, endsAt });
      assert.equal(first.syncVersion, 1n);
      assert.equal(first.intervalCount, 1);
      assert.deepEqual(provider.seenSyncTokens, [null]);

      const second = await service.syncBusy({ tenantId, connectionId, startsAt, endsAt });
      assert.equal(second.syncVersion, 2n);
      assert.deepEqual(provider.seenSyncTokens, [null, 'checkpoint-1']);

      const [checkpoint] = await admin.$queryRaw<Array<{ token: string | null; version: bigint }>>`
        SELECT sync_token AS token, sync_version AS version
        FROM calendar_connections
        WHERE tenant_id=${tenantId}::uuid AND id=${connectionId}::uuid
      `;
      assert.equal(checkpoint?.token, 'checkpoint-2');
      assert.equal(checkpoint?.version, 2n);

      const pause = provider.pauseNext();
      const stalePublish = service.syncBusy({ tenantId, connectionId, startsAt, endsAt });
      await pause.entered;

      const winnerVersion = await store.replaceBusySnapshot({
        tenantId,
        connectionId,
        expectedSyncVersion: 2n,
        observedAt: new Date(),
        syncToken: 'winner-checkpoint',
        intervals: [
          {
            startsAt: new Date('2030-01-01T10:00:00Z'),
            endsAt: new Date('2030-01-01T10:30:00Z'),
          },
        ],
      });
      assert.equal(winnerVersion, 3n);
      pause.release();
      await assert.rejects(stalePublish, (error) => error instanceof CalendarProviderConflict);

      const snapshot = await store.busySnapshot({
        tenantId,
        connectionId,
        startsAt,
        endsAt,
      });
      assert.equal(snapshot.syncVersion, 3n);
      assert.deepEqual(snapshot.intervals, [
        { startsAt: '2030-01-01T10:00:00.000Z', endsAt: '2030-01-01T10:30:00.000Z' },
      ]);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
