import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { CalendarCredentialStore, calendarCredentialReference } from './calendar-credential-store';

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface CalendarCredentialRotationTarget {
  tenantId: string;
  connectionId: string;
  keyId: string;
}

export async function reencryptCalendarCredentials(
  deps: Dependencies,
  credentials: CalendarCredentialStore,
  batchSize = 100,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)
    throw new Error('Invalid calendar credential rotation batch size');

  const currentKeyId = credentials.currentKeyId;
  if (!KEY_ID.test(currentKeyId))
    throw new Error('Invalid calendar credential rotation configuration');

  const seen = new Set<string>();
  let migrated = 0;
  for (;;) {
    const targets = await deps.db.$queryRaw<CalendarCredentialRotationTarget[]>(Prisma.sql`
      SELECT
        tenant_id::text AS "tenantId",
        connection_id::text AS "connectionId",
        key_id AS "keyId"
      FROM discover_calendar_credentials_for_reencryption(${currentKeyId}, ${batchSize})
    `);
    if (targets.length === 0) return migrated;

    for (const target of targets) {
      if (
        !isUUID(target.tenantId) ||
        !isUUID(target.connectionId) ||
        !KEY_ID.test(target.keyId) ||
        target.keyId === currentKeyId
      )
        throw new Error('Invalid calendar credential rotation target');

      const identity = `${target.tenantId}:${target.connectionId}`;
      if (seen.has(identity)) throw new Error('Calendar credential key rotation did not converge');
      seen.add(identity);

      try {
        await credentials.read(calendarCredentialReference(target.tenantId, target.connectionId));
      } catch {
        throw new Error('Calendar credential key rotation is blocked');
      }
      migrated += 1;
    }
  }
}
