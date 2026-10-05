import 'reflect-metadata';
import { parseGoogleCalendarOAuthConfig } from '../src/calendar/google-calendar-oauth-config';
import { createGoogleCalendarCredentialRuntime } from '../src/calendar/google-calendar-credential-store-factory';
import { reencryptCalendarCredentials } from '../src/calendar/calendar-credential-key-rotation';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const oauth = parseGoogleCalendarOAuthConfig(process.env);
  if (!oauth.enabled) throw new Error('Google Calendar OAuth must be enabled for key rotation');

  const deps = new Dependencies(config);
  try {
    const { credentials } = await createGoogleCalendarCredentialRuntime(config, deps, oauth);
    const migrated = await reencryptCalendarCredentials(deps, credentials);
    process.stdout.write(
      JSON.stringify({
        status: 'complete',
        currentKeyId: credentials.currentKeyId,
        migrated,
      }) + '\n',
    );
  } finally {
    await deps.onModuleDestroy();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Calendar credential key rotation failed';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
