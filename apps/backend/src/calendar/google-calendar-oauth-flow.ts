import { BadRequestException } from '@nestjs/common';
import { Actor } from '../identity/auth.service';
import { CalendarOAuthStateService } from './calendar-oauth-state.service';
import { GoogleCalendarOAuthService } from './google-calendar-oauth.service';
import { GoogleOAuthAuthorizationClient } from './google-oauth-authorization-client';

export interface GoogleCalendarOAuthStartResponse {
  authorizationUrl: string;
  expiresAt: string;
}

export class GoogleCalendarOAuthFlow {
  constructor(
    private readonly states: CalendarOAuthStateService,
    private readonly authorization: GoogleOAuthAuthorizationClient,
    private readonly completion: GoogleCalendarOAuthService,
    private readonly callbackUri: string,
  ) {}

  async begin(actor: Actor, tenantId: string): Promise<GoogleCalendarOAuthStartResponse> {
    const start = await this.states.begin(actor, tenantId, this.callbackUri);
    return {
      authorizationUrl: this.authorization.build(start),
      expiresAt: start.expiresAt,
    };
  }

  complete(state: string, code: string) {
    return this.completion.complete(state, code);
  }

  async reject(state: string): Promise<never> {
    await this.states.consume(state);
    throw new BadRequestException('Google OAuth authorization failed');
  }
}
