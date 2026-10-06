import { z } from 'zod';

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const previousKeysSchema = z
  .array(
    z.object({
      id: z.string().regex(KEY_ID),
      reference: z.string().max(1024),
    }),
  )
  .max(16);

const schema = z.object({
  GOOGLE_CALENDAR_OAUTH_ENABLED: z.enum(['false', 'true']).default('false'),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().max(512).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CLIENT_SECRET_REF: z.string().max(1024).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CALLBACK_URI: z.string().max(2048).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CREDENTIAL_KEY_ID: z.string().regex(KEY_ID).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CREDENTIAL_KEY_REF: z.string().max(1024).optional().or(z.literal('')),
  GOOGLE_CALENDAR_CREDENTIAL_PREVIOUS_KEYS: z.string().max(16384).optional().or(z.literal('')),
});

export interface GoogleCalendarCredentialKeyReference {
  id: string;
  reference: string;
}

export interface GoogleCalendarOAuthConfig {
  enabled: boolean;
  clientId: string | null;
  clientSecretReference: string | null;
  callbackUri: string | null;
  credentialKeyId: string | null;
  credentialKeyReference: string | null;
  credentialPreviousKeys: GoogleCalendarCredentialKeyReference[];
}

function text(value: string | undefined): string | null {
  if (!value) return null;
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Invalid Google Calendar OAuth configuration');
  return value;
}

function previousKeys(value: string | undefined): GoogleCalendarCredentialKeyReference[] {
  const raw = text(value);
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('Invalid Google Calendar OAuth configuration');
  }
  const parsed = previousKeysSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('Invalid Google Calendar OAuth configuration');

  const ids = new Set<string>();
  return parsed.data.map((item) => {
    if (ids.has(item.id)) throw new Error('Invalid Google Calendar OAuth configuration');
    ids.add(item.id);
    const reference = text(item.reference);
    if (!reference) throw new Error('Invalid Google Calendar OAuth configuration');
    return { id: item.id, reference };
  });
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
  const credentialPreviousKeys = previousKeys(parsed.data.GOOGLE_CALENDAR_CREDENTIAL_PREVIOUS_KEYS);
  const configured = [
    clientId,
    clientSecretReference,
    callback,
    credentialKeyId,
    credentialKeyReference,
  ].some(Boolean);

  if (parsed.data.GOOGLE_CALENDAR_OAUTH_ENABLED === 'false') {
    if (configured || credentialPreviousKeys.length > 0)
      throw new Error('Google Calendar OAuth fields require explicit enablement');
    return {
      enabled: false,
      clientId: null,
      clientSecretReference: null,
      callbackUri: null,
      credentialKeyId: null,
      credentialKeyReference: null,
      credentialPreviousKeys: [],
    };
  }

  if (
    !clientId ||
    !clientSecretReference ||
    !callback ||
    !credentialKeyId ||
    !credentialKeyReference ||
    credentialPreviousKeys.some((key) => key.id === credentialKeyId)
  )
    throw new Error('Google Calendar OAuth requires complete server-side configuration');

  return {
    enabled: true,
    clientId,
    clientSecretReference,
    callbackUri: callbackUri(callback),
    credentialKeyId,
    credentialKeyReference,
    credentialPreviousKeys,
  };
}
