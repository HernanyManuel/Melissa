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
    // Dedicated seed connection; scope before any RLS-protected operation.
    await db.$executeRaw`SELECT set_config('app.actor_id', ${user.id}, false)`;
    await db.$executeRaw`SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000123', false)`;
    const tenant = await db.tenant.upsert({
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
    await db.membership.upsert({
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
      await db.businessService.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug } },
        update: {},
        create: { tenantId: tenant.id, slug, name, price, currency: 'EUR', durationMinutes },
      });
    }
    await db.businessHour.deleteMany({ where: { tenantId: tenant.id } });
    await db.businessHour.createMany({
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
    if ((await db.faq.count({ where: { tenantId: tenant.id } })) === 0) {
      await db.faq.createMany({
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
  } finally {
    await db.$disconnect();
  }
}
void seed();
