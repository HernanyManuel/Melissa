import { createHash } from 'node:crypto';
import {
  CalendarBookingCancellation,
  CalendarBookingMutation,
  CalendarBusyInterval,
  CalendarBusyRequest,
  CalendarBusyResult,
  CalendarExternalEvent,
  CalendarProvider,
  CalendarProviderConflict,
  CalendarProviderInvalidRequest,
  CalendarProviderUnavailable,
} from './calendar-provider';

interface StoredEvent {
  startsAt: string;
  endsAt: string;
  timezone: string;
  version: number;
  cancelled: boolean;
}

interface OperationResult {
  fingerprint: string;
  result: CalendarExternalEvent;
}

function exactInstant(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new CalendarProviderInvalidRequest();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new CalendarProviderInvalidRequest();
  return parsed.toISOString();
}

function nonEmpty(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) throw new CalendarProviderInvalidRequest();
  return trimmed;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function externalEventId(connectionId: string, bookingId: string): string {
  return createHash('sha256').update(`${connectionId}:${bookingId}`).digest('hex').slice(0, 32);
}

export class MockCalendarProvider implements CalendarProvider {
  readonly providerKey = 'mock';
  private available = true;
  private readonly busyByConnection = new Map<string, CalendarBusyInterval[]>();
  private readonly events = new Map<string, StoredEvent>();
  private readonly operations = new Map<string, OperationResult>();

  setAvailable(available: boolean): void {
    this.available = available;
  }

  setBusy(connectionId: string, intervals: readonly CalendarBusyInterval[]): void {
    const key = nonEmpty(connectionId);
    const normalized = intervals.map((interval) => {
      const startsAt = exactInstant(interval.startsAt);
      const endsAt = exactInstant(interval.endsAt);
      if (endsAt <= startsAt) throw new CalendarProviderInvalidRequest();
      return { startsAt, endsAt };
    });
    this.busyByConnection.set(
      key,
      normalized.sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
    );
  }

  async busy(request: CalendarBusyRequest): Promise<CalendarBusyResult> {
    this.ensureAvailable();
    const connectionId = this.validateConnection(request.connection);
    const startsAt = exactInstant(request.startsAt);
    const endsAt = exactInstant(request.endsAt);
    if (endsAt <= startsAt) throw new CalendarProviderInvalidRequest();
    if (request.syncToken !== null) nonEmpty(request.syncToken);
    const intervals = (this.busyByConnection.get(connectionId) ?? []).filter(
      (interval) => interval.startsAt < endsAt && interval.endsAt > startsAt,
    );
    return {
      observedAt: new Date().toISOString(),
      intervals: intervals.map((interval) => ({ ...interval })),
      syncToken: request.syncToken,
    };
  }

  async upsertBooking(request: CalendarBookingMutation): Promise<CalendarExternalEvent> {
    this.ensureAvailable();
    const connectionId = this.validateConnection(request.connection);
    const bookingId = nonEmpty(request.bookingId);
    const operationKey = nonEmpty(request.operationKey);
    const startsAt = exactInstant(request.startsAt);
    const endsAt = exactInstant(request.endsAt);
    if (endsAt <= startsAt) throw new CalendarProviderInvalidRequest();
    const timezone = nonEmpty(request.timezone);
    const operationFingerprint = fingerprint({
      type: 'upsert',
      connectionId,
      bookingId,
      startsAt,
      endsAt,
      timezone,
    });
    const replay = this.replay(connectionId, operationKey, operationFingerprint);
    if (replay) return replay;

    const eventKey = `${connectionId}:${bookingId}`;
    const previous = this.events.get(eventKey);
    const next: StoredEvent = {
      startsAt,
      endsAt,
      timezone,
      version: (previous?.version ?? 0) + 1,
      cancelled: false,
    };
    this.events.set(eventKey, next);
    return this.commitOperation(connectionId, operationKey, operationFingerprint, {
      externalEventId: externalEventId(connectionId, bookingId),
      version: String(next.version),
      cancelled: false,
    });
  }

  async cancelBooking(request: CalendarBookingCancellation): Promise<CalendarExternalEvent> {
    this.ensureAvailable();
    const connectionId = this.validateConnection(request.connection);
    const bookingId = nonEmpty(request.bookingId);
    const operationKey = nonEmpty(request.operationKey);
    const operationFingerprint = fingerprint({ type: 'cancel', connectionId, bookingId });
    const replay = this.replay(connectionId, operationKey, operationFingerprint);
    if (replay) return replay;

    const eventKey = `${connectionId}:${bookingId}`;
    const previous = this.events.get(eventKey);
    const next: StoredEvent = {
      startsAt: previous?.startsAt ?? '1970-01-01T00:00:00.000Z',
      endsAt: previous?.endsAt ?? '1970-01-01T00:00:00.000Z',
      timezone: previous?.timezone ?? 'UTC',
      version: (previous?.version ?? 0) + 1,
      cancelled: true,
    };
    this.events.set(eventKey, next);
    return this.commitOperation(connectionId, operationKey, operationFingerprint, {
      externalEventId: externalEventId(connectionId, bookingId),
      version: String(next.version),
      cancelled: true,
    });
  }

  private validateConnection(connection: CalendarBusyRequest['connection']): string {
    const connectionId = nonEmpty(connection.connectionId);
    nonEmpty(connection.calendarRef);
    nonEmpty(connection.credentialRef);
    return connectionId;
  }

  private ensureAvailable(): void {
    if (!this.available) throw new CalendarProviderUnavailable();
  }

  private replay(
    connectionId: string,
    operationKey: string,
    operationFingerprint: string,
  ): CalendarExternalEvent | undefined {
    const stored = this.operations.get(`${connectionId}:${operationKey}`);
    if (!stored) return undefined;
    if (stored.fingerprint !== operationFingerprint) throw new CalendarProviderConflict();
    return { ...stored.result };
  }

  private commitOperation(
    connectionId: string,
    operationKey: string,
    operationFingerprint: string,
    result: CalendarExternalEvent,
  ): CalendarExternalEvent {
    const copy = { ...result };
    this.operations.set(`${connectionId}:${operationKey}`, {
      fingerprint: operationFingerprint,
      result: copy,
    });
    return { ...copy };
  }
}
