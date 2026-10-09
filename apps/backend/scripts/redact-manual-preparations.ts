import { PrismaClient } from '@prisma/client';
import {
  pendingRedactionCount,
  redactExpiredPreparations,
} from '../src/messaging/manual-reply-retention';

async function main(): Promise<void> {
  // No implicit mutations; operators must supply both privileged connection
  // and --apply. Never print connection strings, IDs, or customer messages.
  const apply = process.argv.includes('--apply');
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) throw new Error('Use --apply or no arguments');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const eligible = await pendingRedactionCount(db);
    if (!apply) {
      process.stdout.write(
        `dry-run: ${eligible} preparations eligible for redaction; no changes\n`,
      );
      return;
    }
    const scrubbed = await redactExpiredPreparations(db, 500);
    const remaining = await pendingRedactionCount(db);
    process.stdout.write(`redacted: ${scrubbed} prepared messages; ${remaining} remain eligible\n`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch(() => {
    // Fail without logging driver errors that may contain credentials or text.
    process.stderr.write('Manual reply retention failed; check controlled operator logs\n');
    process.exitCode = 1;
  });
}
