import { PrismaClient } from '@prisma/client';
import { passwordHash } from '../src/identity/password';

async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Development seed is disabled in production.');
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  const password = process.env.DEMO_PASSWORD;
  if (!databaseUrl || !password || password.length < 12)
    throw new Error('MIGRATION_DATABASE_URL and DEMO_PASSWORD (12+ characters) are required.');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const user = await db.user.upsert({
      where: { email: 'demo@melissa.local' },
      update: {},
      create: {
        email: 'demo@melissa.local',
        name: 'Demo Owner',
        passwordHash: await passwordHash(password),
        verifiedAt: new Date(),
        termsVersion: 'development-2026-09-02',
        termsAcceptedAt: new Date(),
      },
    });
    await db.$transaction(async (tx) => {
      // Transaction-local scope keeps RLS context on the same pooled connection.
      await tx.$executeRaw`SELECT set_config('app.actor_id', ${user.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000123', true)`;
      const tenant = await tx.tenant.upsert({
        where: { id: '00000000-0000-4000-8000-000000000123' },
        update: {},
        create: {
          id: '00000000-0000-4000-8000-000000000123',
          name: 'Barbearia Central',
          countryCode: 'PT',
          timezone: 'Europe/Lisbon',
          city: 'Lisboa',
          industryKey: 'barbershop',
          locale: 'pt',
          currency: 'EUR',
          onboardingStep: 9,
        },
      });
      await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        update: { active: true, role: 'owner' },
        create: { tenantId: tenant.id, userId: user.id, role: 'owner' },
      });
      const services = [
        ['corte', 'Corte', '18.00', 30],
        ['barba', 'Barba', '12.00', 20],
        ['corte-barba', 'Corte + Barba', '27.00', 50],
      ] as const;
      for (const [slug, name, price, durationMinutes] of services) {
        await tx.businessService.upsert({
          where: { tenantId_slug: { tenantId: tenant.id, slug } },
          update: {},
          create: { tenantId: tenant.id, slug, name, price, currency: 'EUR', durationMinutes },
        });
      }
      await tx.businessHour.deleteMany({ where: { tenantId: tenant.id } });
      await tx.businessHour.createMany({
        data: [
          ...[1, 2, 3, 4, 5].map((weekday) => ({
            tenantId: tenant.id,
            weekday,
            startTime: '09:00',
            endTime: '19:00',
          })),
          { tenantId: tenant.id, weekday: 6, startTime: '09:00', endTime: '14:00' },
        ],
      });
      if ((await tx.faq.count({ where: { tenantId: tenant.id } })) === 0) {
        await tx.faq.createMany({
          data: [
            { tenantId: tenant.id, question: 'Aceitam cartão?', answer: 'Sim.' },
            {
              tenantId: tenant.id,
              question: 'Há estacionamento?',
              answer: 'Existe estacionamento público próximo.',
            },
          ],
        });
      }
    });
  } finally {
    await db.$disconnect();
  }
}
void seed();
