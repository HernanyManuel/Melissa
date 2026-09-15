import { z } from 'zod';

const schema = z.object({
  GOOGLE_CALENDAR_OAUTH_ENABLED: z.enum(['false', 'true']).default('false'),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().max(512).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CLIENT_SECRET_REF: z.string().max(1024).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CALLBACK_URI: z.string().max(2048).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CREDENTIAL_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .or(z.literal('')),
  GOOGLE_CALENDAR_CREDENTIAL_KEY_REF: z.string().max(1024).optional().or(z.literal('')),
});

export interface GoogleCalendarOAuthConfig {
  enabled: boolean;
  clientId: string | null;
  clientSecretReference: string | null;
  callbackUri: string | null;
  credentialKeyId: string | null;
  credentialKeyReference: string | null;
}

function text(value: string | undefined): string | null {
  if (!value) return null;
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Invalid Google Calendar OAuth configuration');
  return value;
}

function callbackUri(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('invalid callback');
    return url.toString();
  } catch {
    throw new Error('Invalid Google Calendar OAuth configuration');
  }
}

export function parseGoogleCalendarOAuthConfig(
  input: Record<string, unknown>,
): GoogleCalendarOAuthConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid Google Calendar OAuth configuration');

  const clientId = text(parsed.data.GOOGLE_CALENDAR_CLIENT_ID);
  const clientSecretReference = text(parsed.data.GOOGLE_CALENDAR_CLIENT_SECRET_REF);
  const callback = text(parsed.data.GOOGLE_CALENDAR_CALLBACK_URI);
  const credentialKeyId = text(parsed.data.GOOGLE_CALENDAR_CREDENTIAL_KEY_ID);
  const credentialKeyReference = text(parsed.data.GOOGLE_CALENDAR_CREDENTIAL_KEY_REF);
  const configured = [
    clientId,
    clientSecretReference,
    callback,
    credentialKeyId,
    credentialKeyReference,
  ].some(Boolean);

  if (parsed.data.GOOGLE_CALENDAR_OAUTH_ENABLED === 'false') {
    if (configured) throw new Error('Google Calendar OAuth fields require explicit enablement');
    return {
      enabled: false,
      clientId: null,
      clientSecretReference: null,
      callbackUri: null,
      credentialKeyId: null,
      credentialKeyReference: null,
    };
  }

  if (
    !clientId ||
    !clientSecretReference ||
    !callback ||
    !credentialKeyId ||
    !credentialKeyReference
  )
    throw new Error('Google Calendar OAuth requires complete server-side configuration');

  return {
    enabled: true,
    clientId,
    clientSecretReference,
    callbackUri: callbackUri(callback),
    credentialKeyId,
    credentialKeyReference,
  };
}
