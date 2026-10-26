import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// Synthetic-only benchmark data: NEVER run against a shared/production database.
// Usage (local disposable DB only):
// NODE_ENV=test P10_SYNTHETIC_LOAD=YES P10_SYNTHETIC_SIZE=small \\
// MIGRATION_DATABASE_URL=postgresql://...@localhost:5432/melissa_test \\
// pnpm --filter @melissa/backend exec tsx scripts/seed-analytics-benchmark.ts

const url = process.env.MIGRATION_DATABASE_URL;
const size = process.env.P10_SYNTHETIC_SIZE ?? 'small';
const volumes: Record<string, [number, number, number]> = {
  small: [100, 300, 300],
  medium: [10000, 30000, 30000],
  large: [100000, 300000, 300000],
};
if (process.env.NODE_ENV !== 'test' || process.env.P10_SYNTHETIC_LOAD !== 'YES' || !url) {
  throw new Error('Synthetic benchmark requires test mode, explicit consent and migration URL');
}
const parsed = new URL(url);
if (
  !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
  !/(?:test|disposable)/i.test(parsed.pathname)
) {
  throw new Error('Refusing benchmark load outside a local disposable test database');
}
if (!volumes[size]) {
  throw new Error('P10_SYNTHETIC_SIZE must be small, medium or large');
}
if (size !== 'small' && process.env.P10_SYNTHETIC_LARGE_ACK !== 'YES') {
  throw new Error('Medium/large synthetic load needs P10_SYNTHETIC_LARGE_ACK=YES');
}

const db = new PrismaClient({ datasources: { db: { url } } });
const chunk = 500;
const stamp = Date.now();

const run = async () => {
  for (let tenantIndex = 0; tenantIndex < 2; tenantIndex++) {
    const [conversations, turns, audits] = volumes[size]!;
    const tenant = await db.tenant.create({
      data: {
        id: randomUUID(),
        name: `P10 synthetic ${size} ${tenantIndex}`,
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
      },
    });
    const channel = await db.channelConnection.create({
      data: {
        tenantId: tenant.id,
        id: randomUUID(),
        channelType: 'webchat',
        mode: 'mock',
        externalAccountId: `mock:${randomUUID()}`,
        externalPhoneId: `mock:${randomUUID()}`,
        displayName: 'P10 benchmark only',
        status: 'active',
      },
    });
    // Conversation uniqueness is (tenant, channel, customer). Use one
    // synthetic customer per conversation, inserted before its conversation.
    const ids: Array<{ customerId: string; conversationId: string }> = [];
    for (let start = 0; start < conversations; start += chunk) {
      const end = Math.min(conversations, start + chunk);
      const customers = Array.from({ length: end - start }, (_, j) => {
        const n = start + j;
        const customerId = randomUUID();
        const conversationId = randomUUID();
        ids.push({ customerId, conversationId });
        return {
          tenantId: tenant.id,
          id: customerId,
          displayName: 'Synthetic benchmark',
          phoneE164: `+351${(900000000 + n).toString()}`,
          updatedAt: new Date(stamp),
        };
      });
      await db.customer.createMany({ data: customers });
      await db.conversation.createMany({
        data: ids.slice(start, end).map((v, j) => ({
          tenantId: tenant.id,
          id: v.conversationId,
          customerId: v.customerId,
          channelConnectionId: channel.id,
          lastMessageAt: new Date(stamp),
          openedAt: new Date(stamp - ((start + j) % 60) * 86400000),
          updatedAt: new Date(stamp),
        })),
      });
    }
    for (let start = 0; start < turns; start += chunk) {
      const data = Array.from({ length: Math.min(chunk, turns - start) }, (_, j) => {
        const n = start + j;
        const link = ids[n % ids.length]!;
        const status = n % 3 === 0 ? 'running' : n % 3 === 1 ? 'completed' : 'failed';
        const at = new Date(stamp - (n % 60) * 86400000);
        return {
          tenantId: tenant.id,
          id: randomUUID(),
          conversationId: link.conversationId,
          customerId: link.customerId,
          modeEpoch: 0n,
          stateVersion: 0n,
          status,
          rounds: 0,
          startedAt: at,
          ...(status === 'running'
            ? {}
            : {
                completedAt: at,
                ...(status === 'failed' ? { failureCode: 'benchmark_test' } : {}),
              }),
        };
      });
      await db.aiTurn.createMany({ data });
    }
    for (let start = 0; start < audits; start += chunk) {
      await db.auditEvent.createMany({
        data: Array.from({ length: Math.min(chunk, audits - start) }, (_, j) => ({
          tenantId: tenant.id,
          id: randomUUID(),
          actorType: 'system',
          actorId: null,
          action: 'benchmark.synthetic',
          targetId: tenant.id,
          createdAt: new Date(stamp - ((start + j) % 60) * 86400000),
        })),
      });
    }
    process.stdout.write(
      `P10 synthetic ${tenantIndex}: tenant=${tenant.id}, conversations=${conversations}, turns=${turns}, audits=${audits}\n`,
    );
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
