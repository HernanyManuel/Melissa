import { ServiceUnavailableException } from '@nestjs/common';
import { Configuration } from '../config';
import { Dependencies } from '../dependencies';
import { Actor } from '../identity/auth.service';
import { createSecretResolver } from '../secrets/secret-resolver-factory';
import { TenantService } from '../tenancy/tenant.service';
import { createCalendarCredentialKeyring } from './calendar-credential-keyring';
import { CalendarCredentialStore } from './calendar-credential-store';
import { CalendarOAuthStateService } from './calendar-oauth-state.service';
import {
  GoogleCalendarOAuthConfig,
  parseGoogleCalendarOAuthConfig,
} from './google-calendar-oauth-config';
import { GoogleCalendarOAuthFlow } from './google-calendar-oauth-flow';
import { GoogleCalendarOAuthService } from './google-calendar-oauth.service';
import { GoogleOAuthAuthorizationClient } from './google-oauth-authorization-client';
import { GoogleOAuthTokenClient } from './google-oauth-token-client';

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;

export class GoogleCalendarOAuthRuntime {
  constructor(private readonly flow: GoogleCalendarOAuthFlow | null) {}

  begin(actor: Actor, tenantId: string) {
    return this.requireFlow().begin(actor, tenantId);
  }

  complete(state: string, code: string) {
    return this.requireFlow().complete(state, code);
  }

  reject(state: string) {
    return this.requireFlow().reject(state);
  }

  private requireFlow(): GoogleCalendarOAuthFlow {
    if (!this.flow) throw new ServiceUnavailableException('Google Calendar OAuth is unavailable');
    return this.flow;
  }
}

export async function createGoogleCalendarOAuthRuntime(
  config: Configuration,
  deps: Dependencies,
  tenants: TenantService,
  environment: Record<string, unknown> = process.env,
): Promise<GoogleCalendarOAuthRuntime> {
  const oauth = parseGoogleCalendarOAuthConfig(environment);
  if (!oauth.enabled) return new GoogleCalendarOAuthRuntime(null);
  return new GoogleCalendarOAuthRuntime(await createEnabledFlow(config, deps, tenants, oauth));
}

async function createEnabledFlow(
  config: Configuration,
  deps: Dependencies,
  tenants: TenantService,
  oauth: GoogleCalendarOAuthConfig,
): Promise<GoogleCalendarOAuthFlow> {
  if (
    config.SECRET_PROVIDER !== 'mounted-file' ||
    !oauth.clientId ||
    !oauth.clientSecretReference ||
    !oauth.callbackUri ||
    !oauth.credentialKeyId ||
    !oauth.credentialKeyReference
  )
    throw new Error('Google Calendar OAuth requires mounted server-side secrets');

  const secrets = await createSecretResolver(config);
  if (!secrets) throw new Error('Google Calendar OAuth secret resolver is unavailable');
  const keyring = await createCalendarCredentialKeyring(
    secrets,
    oauth.credentialKeyId,
    oauth.credentialKeyReference,
  );
  const tokens = new GoogleOAuthTokenClient(secrets, oauth.clientId, oauth.clientSecretReference);
  const credentials = new CalendarCredentialStore(deps, keyring, tokens);
  const states = new CalendarOAuthStateService(deps, tenants, [oauth.callbackUri]);
  const authorization = new GoogleOAuthAuthorizationClient(oauth.clientId, GOOGLE_CALENDAR_SCOPES);
  const completion = new GoogleCalendarOAuthService(deps, tenants, states, tokens, credentials);
  return new GoogleCalendarOAuthFlow(states, authorization, completion, oauth.callbackUri);
}
