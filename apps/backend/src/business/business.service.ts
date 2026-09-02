import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from '../identity/auth.service';
import { Dependencies } from '../dependencies';
import { TenantService } from '../tenancy/tenant.service';
import {
  BusinessProfileDto,
  ConfigurationDto,
  FaqDto,
  HoursDto,
  ScheduleExceptionDto,
  ServiceDto,
  StaffDto,
} from './dto';

@Injectable()
export class BusinessService {
  constructor(
    private readonly tenants: TenantService,
    private readonly deps: Dependencies,
  ) {}
  templates() {
    return this.deps.db.industryTemplate.findMany({
      where: { enabled: true },
      select: { key: true, name: true, description: true },
      orderBy: { key: 'asc' },
    });
  }
  profile(actor: Actor, tenantId: string, input: BusinessProfileDto) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
    } catch {
      throw new BadRequestException();
    }
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const template = await tx.industryTemplate.findUnique({ where: { key: input.industryKey } });
      if (!template?.enabled) throw new BadRequestException();
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: { ...input, onboardingStep: 3, provisioningStatus: 'configuring' },
      });
      await this.tenants.audit(tx, actor, tenantId, 'onboarding.profile_saved', tenantId);
      return tenant;
    });
  }
  listServices(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', (tx) =>
      tx.businessService.findMany({
        where: { tenantId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
    );
  }
  createService(actor: Actor, tenantId: string, input: ServiceDto) {
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const slugBase =
        input.name
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 70) || 'service';
      const count = await tx.businessService.count({
        where: { tenantId, slug: { startsWith: slugBase } },
      });
      const service = await tx.businessService.create({
        data: { tenantId, ...input, slug: count ? `${slugBase}-${count + 1}` : slugBase },
      });
      await tx.tenant.update({ where: { id: tenantId }, data: { onboardingStep: 4 } });
      await this.tenants.audit(tx, actor, tenantId, 'service.created', service.id);
      return service;
    });
  }
  updateService(actor: Actor, tenantId: string, id: string, input: ServiceDto) {
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const exists = await tx.businessService.findUnique({
        where: { tenantId_id: { tenantId, id } },
      });
      if (!exists || exists.deletedAt) throw new NotFoundException();
      const result = await tx.businessService.update({
        where: { tenantId_id: { tenantId, id } },
        data: input,
      });
      await this.tenants.audit(tx, actor, tenantId, 'service.updated', id);
      return result;
    });
  }
  deleteService(actor: Actor, tenantId: string, id: string) {
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const changed = await tx.businessService.updateMany({
        where: { tenantId, id, deletedAt: null },
        data: { deletedAt: new Date(), active: false },
      });
      if (changed.count !== 1) throw new NotFoundException();
      await this.tenants.audit(tx, actor, tenantId, 'service.deleted', id);
    });
  }
  getHours(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', async (tx) => ({
      periods: await tx.businessHour.findMany({
        where: { tenantId },
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      }),
      exceptions: await tx.scheduleException.findMany({
        where: { tenantId },
        orderBy: { date: 'asc' },
        take: 366,
      }),
    }));
  }
  replaceHours(actor: Actor, tenantId: string, input: HoursDto) {
    for (const item of input.periods)
      if (item.startTime >= item.endTime) throw new BadRequestException();
    for (const [index, item] of input.periods.entries()) {
      if (
        input.periods.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.weekday === item.weekday &&
            item.startTime < other.endTime &&
            other.startTime < item.endTime,
        )
      )
        throw new BadRequestException();
    }
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      await tx.businessHour.deleteMany({ where: { tenantId } });
      await tx.businessHour.createMany({
        data: input.periods.map((item) => ({ tenantId, ...item })),
      });
      await tx.tenant.update({ where: { id: tenantId }, data: { onboardingStep: 5 } });
      await this.tenants.audit(tx, actor, tenantId, 'business_hours.replaced', tenantId);
      return this.getHoursInTransaction(tx, tenantId);
    });
  }
  addException(actor: Actor, tenantId: string, input: ScheduleExceptionDto) {
    if (
      input.closed
        ? input.startTime || input.endTime
        : !input.startTime || !input.endTime || input.startTime >= input.endTime
    )
      throw new BadRequestException();
    const date = new Date(`${input.date}T00:00:00.000Z`);
    if (Number.isNaN(date.valueOf())) throw new BadRequestException();
    return this.tenants.scoped(actor, tenantId, 'business:write', (tx) =>
      tx.scheduleException.create({ data: { tenantId, ...input, date } }),
    );
  }
  private async getHoursInTransaction(tx: Prisma.TransactionClient, tenantId: string) {
    return { periods: await tx.businessHour.findMany({ where: { tenantId } }) };
  }
  listFaqs(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', (tx) =>
      tx.faq.findMany({ where: { tenantId }, take: 100 }),
    );
  }
  createFaq(actor: Actor, tenantId: string, input: FaqDto) {
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const faq = await tx.faq.create({ data: { tenantId, ...input } });
      await tx.tenant.update({ where: { id: tenantId }, data: { onboardingStep: 7 } });
      await this.tenants.audit(tx, actor, tenantId, 'faq.created', faq.id);
      return faq;
    });
  }
  listStaff(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', (tx) =>
      tx.staff.findMany({ where: { tenantId }, include: { services: true }, take: 100 }),
    );
  }
  createStaff(actor: Actor, tenantId: string, input: StaffDto) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
    } catch {
      throw new BadRequestException();
    }
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const services = await tx.businessService.findMany({
        where: { tenantId, id: { in: input.serviceIds }, deletedAt: null },
        select: { id: true },
      });
      if (services.length !== new Set(input.serviceIds).size) throw new BadRequestException();
      const { serviceIds, ...data } = input;
      const staff = await tx.staff.create({
        data: {
          tenantId,
          ...data,
          services: { create: serviceIds.map((serviceId) => ({ tenantId, serviceId })) },
        },
        include: { services: true },
      });
      await tx.tenant.update({ where: { id: tenantId }, data: { onboardingStep: 6 } });
      await this.tenants.audit(tx, actor, tenantId, 'staff.created', staff.id);
      return staff;
    });
  }
  getConfiguration(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', (tx) =>
      tx.tenantConfiguration.findUnique({ where: { tenantId } }),
    );
  }
  saveConfiguration(actor: Actor, tenantId: string, input: ConfigurationDto) {
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const config = await tx.tenantConfiguration.upsert({
        where: { tenantId },
        create: { tenantId, ...input },
        update: input,
      });
      await tx.tenant.update({ where: { id: tenantId }, data: { onboardingStep: 9 } });
      await this.tenants.audit(tx, actor, tenantId, 'configuration.saved', tenantId);
      return config;
    });
  }
  status(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', async (tx) => {
      const [tenant, services, hours] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
        tx.businessService.count({ where: { tenantId, active: true, deletedAt: null } }),
        tx.businessHour.count({ where: { tenantId, enabled: true } }),
      ]);
      const completed = {
        business: Boolean(tenant.industryKey && tenant.city),
        services: services > 0,
        schedule: hours > 0,
      };
      return {
        step: tenant.onboardingStep,
        provisioningStatus: tenant.provisioningStatus,
        completed,
        activation: {
          allowed: false,
          blockers: [
            ...(!completed.business ? ['business'] : []),
            ...(!completed.services ? ['services'] : []),
            ...(!completed.schedule ? ['schedule'] : []),
            'channel',
            'calendar',
            'subscription',
            'agent_tests',
          ],
        },
      };
    });
  }
}
