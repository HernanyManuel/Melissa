import { createHash } from 'node:crypto';
import { SecretResolver, validateSecretReference } from '../secrets/secret-resolver';
import {
  CalendarBookingCancellation,
  CalendarBookingMutation,
  CalendarBusyRequest,
  CalendarBusyResult,
  CalendarExternalEvent,
  CalendarProvider,
  CalendarProviderConflict,
  CalendarProviderInvalidRequest,
  CalendarProviderUnavailable,
} from './calendar-provider';

type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BUSY_INTERVALS = 5000;

interface GoogleEvent {
  id?: unknown;
  etag?: unknown;
  status?: unknown;
  start?: { dateTime?: unknown; timeZone?: unknown };
  end?: { dateTime?: unknown; timeZone?: unknown };
  extendedProperties?: { private?: Record<string, unknown> };
}

function exactInstant(value: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new CalendarProviderInvalidRequest();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new CalendarProviderInvalidRequest();
  return parsed.toISOString();
}

function nonEmpty(value: string, maximum = 512): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > maximum)
    throw new CalendarProviderInvalidRequest();
  return trimmed;
}

function eventId(connectionId: string, bookingId: string): string {
  return createHash('sha256').update(`${connectionId}:${bookingId}`).digest('hex').slice(0, 32);
}

function cancellationVersion(operationKey: string): string {
  return `cancelled:${createHash('sha256').update(operationKey).digest('hex').slice(0, 16)}`;
}

/**
 * Google Calendar v3 transport. Construction alone performs no network or secret access.
 * FreeBusy reads are full snapshots; incremental sync is intentionally not advertised.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly providerKey = 'google';

  constructor(
    private readonly secrets: SecretResolver,
    private readonly timeoutMs = 15000,
    private readonly fetcher: HttpFetch = fetch,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error('Invalid Google Calendar configuration');
  }

  async busy(request: CalendarBusyRequest): Promise<CalendarBusyResult> {
    const calendarRef = nonEmpty(request.connection.calendarRef);
    const startsAt = exactInstant(request.startsAt);
    const endsAt = exactInstant(request.endsAt);
    if (endsAt <= startsAt) throw new CalendarProviderInvalidRequest();
    const token = await this.accessToken(request.connection.credentialRef);
    const response = await this.request(`${API_BASE}/freeBusy`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeMin: startsAt, timeMax: endsAt, items: [{ id: calendarRef }] }),
    });
    if (!response.ok) this.throwForStatus(response.status);

    const payload = await this.readJson(response);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new CalendarProviderUnavailable();
    const calendars = (payload as { calendars?: unknown }).calendars;
    if (!calendars || typeof calendars !== 'object' || Array.isArray(calendars))
      throw new CalendarProviderUnavailable();
    const calendar = (calendars as Record<string, unknown>)[calendarRef];
    if (!calendar || typeof calendar !== 'object' || Array.isArray(calendar))
      throw new CalendarProviderUnavailable();
    const errors = (calendar as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) throw new CalendarProviderUnavailable();
    const busy = (calendar as { busy?: unknown }).busy;
    if (!Array.isArray(busy) || busy.length > MAX_BUSY_INTERVALS)
      throw new CalendarProviderUnavailable();

    const intervals = busy.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new CalendarProviderUnavailable();
      const start = (item as { start?: unknown }).start;
      const end = (item as { end?: unknown }).end;
      if (typeof start !== 'string' || typeof end !== 'string')
        throw new CalendarProviderUnavailable();
      const normalizedStart = exactInstant(start);
      const normalizedEnd = exactInstant(end);
      if (normalizedEnd <= normalizedStart) throw new CalendarProviderUnavailable();
      return { startsAt: normalizedStart, endsAt: normalizedEnd };
    });

    return { observedAt: new Date().toISOString(), intervals, syncToken: null };
  }

  async upsertBooking(request: CalendarBookingMutation): Promise<CalendarExternalEvent> {
    const connectionId = nonEmpty(request.connection.connectionId);
    const calendarRef = nonEmpty(request.connection.calendarRef);
    const bookingId = nonEmpty(request.bookingId);
    nonEmpty(request.operationKey);
    const startsAt = exactInstant(request.startsAt);
    const endsAt = exactInstant(request.endsAt);
    nonEmpty(request.timezone, 128);
    if (endsAt <= startsAt) throw new CalendarProviderInvalidRequest();
    const id = eventId(connectionId, bookingId);
    const token = await this.accessToken(request.connection.credentialRef);
    const existing = await this.getEvent(calendarRef, id, token);
    if (existing) return this.reconcileExisting(existing, request, id, token);

    const response = await this.request(
      `${API_BASE}/calendars/${encodeURIComponent(calendarRef)}/events`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.eventBody(request, id)),
      },
    );
    if (response.status === 409) {
      const raced = await this.getEvent(calendarRef, id, token);
      if (!raced) throw new CalendarProviderConflict();
      return this.reconcileExisting(raced, request, id, token);
    }
    if (!response.ok) this.throwForStatus(response.status);
    return this.eventResult(await this.readJson(response), id);
  }

  async cancelBooking(request: CalendarBookingCancellation): Promise<CalendarExternalEvent> {
    const connectionId = nonEmpty(request.connection.connectionId);
    const calendarRef = nonEmpty(request.connection.calendarRef);
    const bookingId = nonEmpty(request.bookingId);
    const operationKey = nonEmpty(request.operationKey);
    const id = eventId(connectionId, bookingId);
    const token = await this.accessToken(request.connection.credentialRef);
    const existing = await this.getEvent(calendarRef, id, token);
    const version = cancellationVersion(operationKey);
    if (!existing || existing.status === 'cancelled')
      return { externalEventId: id, version, cancelled: true };

    const response = await this.request(
      `${API_BASE}/calendars/${encodeURIComponent(calendarRef)}/events/${id}`,
      token,
      { method: 'DELETE' },
    );
    if (response.status !== 404 && response.status !== 410 && !response.ok)
      this.throwForStatus(response.status);
    return { externalEventId: id, version, cancelled: true };
  }

  private async reconcileExisting(
    existing: GoogleEvent,
    request: CalendarBookingMutation,
    id: string,
    token: string,
  ): Promise<CalendarExternalEvent> {
    const operationKey = existing.extendedProperties?.private?.melissaOperationKey;
    if (operationKey === request.operationKey) {
      const currentStart = existing.start?.dateTime;
      const currentEnd = existing.end?.dateTime;
      const currentTimezone = existing.start?.timeZone;
      if (
        typeof currentStart !== 'string' ||
        typeof currentEnd !== 'string' ||
        exactInstant(currentStart) !== exactInstant(request.startsAt) ||
        exactInstant(currentEnd) !== exactInstant(request.endsAt) ||
        currentTimezone !== request.timezone
      ) {
        throw new CalendarProviderConflict();
      }
      return this.eventResult(existing, id);
    }

    const response = await this.request(
      `${API_BASE}/calendars/${encodeURIComponent(request.connection.calendarRef)}/events/${id}`,
      token,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.eventBody(request)),
      },
    );
    if (!response.ok) this.throwForStatus(response.status);
    return this.eventResult(await this.readJson(response), id);
  }

  private eventBody(request: CalendarBookingMutation, id?: string): Record<string, unknown> {
    return {
      ...(id ? { id } : {}),
      summary: 'Melissa booking',
      visibility: 'private',
      transparency: 'opaque',
      start: { dateTime: exactInstant(request.startsAt), timeZone: request.timezone },
      end: { dateTime: exactInstant(request.endsAt), timeZone: request.timezone },
      extendedProperties: {
        private: {
          melissaBookingId: request.bookingId,
          melissaOperationKey: request.operationKey,
        },
      },
    };
  }

  private async getEvent(
    calendarRef: string,
    id: string,
    token: string,
  ): Promise<GoogleEvent | null> {
    const response = await this.request(
      `${API_BASE}/calendars/${encodeURIComponent(calendarRef)}/events/${id}`,
      token,
      { method: 'GET' },
    );
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) this.throwForStatus(response.status);
    const payload = await this.readJson(response);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new CalendarProviderUnavailable();
    return payload as GoogleEvent;
  }

  private eventResult(payload: unknown, expectedId: string): CalendarExternalEvent {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new CalendarProviderUnavailable();
    const event = payload as GoogleEvent;
    if (event.id !== expectedId || typeof event.etag !== 'string' || event.etag.length < 1)
      throw new CalendarProviderUnavailable();
    return { externalEventId: expectedId, version: event.etag, cancelled: false };
  }

  private async accessToken(reference: string): Promise<string> {
    try {
      const token = await this.secrets.resolve(validateSecretReference(reference));
      if (token.length < 16 || token.length > 4096 || token !== token.trim())
        throw new Error('Invalid Google access token');
      return token;
    } catch {
      throw new CalendarProviderUnavailable();
    }
  }

  private async request(url: string, token: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new CalendarProviderUnavailable();
    }
  }

  private throwForStatus(status: number): never {
    if (status === 400 || status === 422) throw new CalendarProviderInvalidRequest();
    if (status === 409 || status === 412) throw new CalendarProviderConflict();
    throw new CalendarProviderUnavailable();
  }

  private async readJson(response: Response): Promise<unknown> {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
      throw new CalendarProviderUnavailable();
    if (!response.body) throw new CalendarProviderUnavailable();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new CalendarProviderUnavailable();
        text += decoder.decode(value, { stream: true });
      }
      const raw = text + decoder.decode();
      return JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof CalendarProviderUnavailable) throw error;
      throw new CalendarProviderUnavailable();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
