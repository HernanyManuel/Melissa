import { Configuration } from '../config';
import { Dependencies } from '../dependencies';
import { createSecretResolver } from '../secrets/secret-resolver-factory';
import { createCalendarCredentialKeyring } from './calendar-credential-keyring';
import {
  CalendarCredentialReauthRequired,
  CalendarCredentialStore,
} from './calendar-credential-store';
import { GoogleCalendarOAuthConfig } from './google-calendar-oauth-config';
import {
  GoogleOAuthInvalidGrant,
  GoogleOAuthTokenClient,
} from './google-oauth-token-client';

export interface GoogleCalendarCredentialRuntime {
  credentials: CalendarCredentialStore;
  tokens: GoogleOAuthTokenClient;
}

export async function createGoogleCalendarCredentialRuntime(
  config: Configuration,
  deps: Dependencies,
  oauth: GoogleCalendarOAuthConfig,
): Promise<GoogleCalendarCredentialRuntime> {
  if (
    !oauth.enabled ||
    config.SECRET_PROVIDER !== 'mounted-file' ||
    !oauth.clientId ||
    !oauth.clientSecretReference ||
    !oauth.credentialKeyId ||
    !oauth.credentialKeyReference
  )
    throw new Error('Google Calendar credentials require mounted server-side secrets');

  const secrets = await createSecretResolver(config);
  if (!secrets) throw new Error('Google Calendar credential secret resolver is unavailable');
  const keyring = await createCalendarCredentialKeyring(
    secrets,
    oauth.credentialKeyId,
    oauth.credentialKeyReference,
  );
  const tokens = new GoogleOAuthTokenClient(secrets, oauth.clientId, oauth.clientSecretReference);
  const credentials = new CalendarCredentialStore(deps, keyring, {
    refresh: async (refreshToken) => {
      try {
        return await tokens.refresh(refreshToken);
      } catch (error) {
        if (error instanceof GoogleOAuthInvalidGrant)
          throw new CalendarCredentialReauthRequired();
        throw error;
      }
    },
  });
  return { credentials, tokens };
}
