import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { Dependencies } from '../dependencies';
import { JsonObject } from './ai-provider';

export interface BusinessToolReader {
  businessInfo(tenantId: string): Promise<JsonObject>;
  services(tenantId: string): Promise<JsonObject>;
  serviceDetails(tenantId: string, serviceId: string): Promise<JsonObject>;
  price(tenantId: string, serviceId: string): Promise<JsonObject>;
  hours(tenantId: string, date: string): Promise<JsonObject>;
  staff(tenantId: string): Promise<JsonObject>;
}

@Injectable()
export class PrismaBusinessToolReader implements BusinessToolReader {
  constructor(private readonly deps: Dependencies) {}

  private read<T>(tenantId: string, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return run(tx);
    });
  }

  businessInfo(tenantId: string): Promise<JsonObject> {
    return this.read(tenantId, async (tx): Promise<JsonObject> => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          city: true,
          address: true,
          website: true,
          timezone: true,
          locale: true,
          currency: true,
        },
      });
      return tenant
        ? {
            found: true,
            name: tenant.name,
            city: tenant.city,
            address: tenant.address,
            website: tenant.website,
            timezone: tenant.timezone,
            locale: tenant.locale,
            currency: tenant.currency,
          }
        : { found: false };
    });
  }

  services(tenantId: string): Promise<JsonObject> {
    return this.read(tenantId, async (tx) => ({
      services: await tx.businessService
        .findMany({
          where: { tenantId, active: true, deletedAt: null },
          select: {
            id: true,
            name: true,
            category: true,
            price: true,
            currency: true,
            durationMinutes: true,
            bookingEnabled: true,
          },
          orderBy: [{ category: 'asc' }, { name: 'asc' }],
          take: 100,
        })
        .then((items) => items.map((item) => ({ ...item, price: item.price.toFixed() }))),
    }));
  }

  serviceDetails(tenantId: string, serviceId: string): Promise<JsonObject> {
    return this.read(tenantId, async (tx): Promise<JsonObject> => {
      const service = await tx.businessService.findFirst({
        where: { tenantId, id: serviceId, active: true, deletedAt: null },
        select: {
          id: true,
          name: true,
          description: true,
          category: true,
          price: true,
          currency: true,
          durationMinutes: true,
          bufferBeforeMinutes: true,
          bufferAfterMinutes: true,
          bookingEnabled: true,
        },
      });
      return service
        ? { found: true, ...service, price: service.price.toFixed() }
        : { found: false };
    });
  }

  price(tenantId: string, serviceId: string): Promise<JsonObject> {
    return this.read(tenantId, async (tx): Promise<JsonObject> => {
      const service = await tx.businessService.findFirst({
        where: { tenantId, id: serviceId, active: true, deletedAt: null },
        select: { id: true, name: true, price: true, currency: true },
      });
      return service
        ? {
            found: true,
            serviceId: service.id,
            serviceName: service.name,
            amount: service.price.toFixed(),
            currency: service.currency,
          }
        : { found: false };
    });
  }

  hours(tenantId: string, date: string): Promise<JsonObject> {
    return this.read(tenantId, async (tx): Promise<JsonObject> => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { timezone: true },
      });
      if (!tenant) return { found: false };
      const day = new Date(`${date}T00:00:00.000Z`);
      const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
      const [periods, exception] = await Promise.all([
        tx.businessHour.findMany({
          where: { tenantId, weekday, enabled: true },
          select: { startTime: true, endTime: true },
          orderBy: { startTime: 'asc' },
          take: 10,
        }),
        tx.scheduleException.findFirst({
          where: { tenantId, date: day },
          select: { closed: true, startTime: true, endTime: true, reason: true },
        }),
      ]);
      return { found: true, date, timezone: tenant.timezone, periods, exception };
    });
  }

  staff(tenantId: string): Promise<JsonObject> {
    return this.read(tenantId, async (tx) => ({
      staff: await tx.staff
        .findMany({
          where: { tenantId, active: true },
          select: {
            id: true,
            name: true,
            roleTitle: true,
            timezone: true,
            services: {
              where: { active: true },
              select: { serviceId: true, customDurationMinutes: true, customPrice: true },
            },
          },
          orderBy: { name: 'asc' },
          take: 100,
        })
        .then((items) =>
          items.map((item) => ({
            ...item,
            services: item.services.map((service) => ({
              ...service,
              customPrice: service.customPrice?.toFixed() ?? null,
            })),
          })),
        ),
    }));
  }
}
