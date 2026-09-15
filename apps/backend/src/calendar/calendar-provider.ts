export interface CalendarConnectionRef {
  connectionId: string;
  calendarRef: string;
  credentialRef: string;
}

export interface CalendarBusyInterval {
  startsAt: string;
  endsAt: string;
}

export interface CalendarBusyRequest {
  connection: CalendarConnectionRef;
  startsAt: string;
  endsAt: string;
  syncToken: string | null;
}

export interface CalendarBusyResult {
  observedAt: string;
  intervals: CalendarBusyInterval[];
  syncToken: string | null;
}

export interface CalendarBookingMutation {
  connection: CalendarConnectionRef;
  bookingId: string;
  operationKey: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}

export interface CalendarBookingCancellation {
  connection: CalendarConnectionRef;
  bookingId: string;
  operationKey: string;
}

export interface CalendarExternalEvent {
  externalEventId: string;
  version: string;
  cancelled: boolean;
}

export interface CalendarProvider {
  readonly providerKey: string;
  busy(request: CalendarBusyRequest): Promise<CalendarBusyResult>;
  upsertBooking(request: CalendarBookingMutation): Promise<CalendarExternalEvent>;
  cancelBooking(request: CalendarBookingCancellation): Promise<CalendarExternalEvent>;
}

export class CalendarProviderUnavailable extends Error {
  constructor() {
    super('Calendar provider unavailable');
    this.name = 'CalendarProviderUnavailable';
  }
}

export class CalendarProviderConflict extends Error {
  constructor() {
    super('Calendar provider conflict');
    this.name = 'CalendarProviderConflict';
  }
}

export class CalendarProviderInvalidRequest extends Error {
  constructor() {
    super('Calendar provider request is invalid');
    this.name = 'CalendarProviderInvalidRequest';
  }
}
