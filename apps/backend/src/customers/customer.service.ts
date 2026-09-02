import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { CustomerDto, CustomerQuery } from './dto';

@Injectable()
export class CustomerService {
  constructor(private readonly tenants: TenantService) {}

  list(actor: Actor, tenantId: string, query: CustomerQuery) {
    return this.tenants.scoped(actor, tenantId, 'customers:read', async (tx) => {
      const rows = await tx.customer.findMany({
        where: { tenantId, deletedAt: null, ...(query.after ? { id: { gt: query.after } } : {}) },
        orderBy: { id: 'asc' },
        take: 51,
      });
      return { items: rows.slice(0, 50), next: rows.length > 50 ? rows[49]!.id : null };
    });
  }

  async save(actor: Actor, tenantId: string, body: CustomerDto, id?: string) {
    try {
      return await this.tenants.scoped(actor, tenantId, 'customers:write', async (tx) => {
        if (id && !(await tx.customer.findFirst({ where: { tenantId, id, deletedAt: null } })))
          throw new NotFoundException();
        const data = {
          displayName: body.displayName,
          phoneE164: body.phoneE164,
          email: body.email ?? null,
          language: body.language,
          notes: body.notes ?? null,
        };
        const customer = id
          ? await tx.customer.update({ where: { tenantId_id: { tenantId, id } }, data })
          : await tx.customer.create({ data: { tenantId, ...data } });
        await this.tenants.audit(
          tx,
          actor,
          tenantId,
          id ? 'customer.updated' : 'customer.created',
          customer.id,
        );
        return customer;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException();
      throw error;
    }
  }

  archive(actor: Actor, tenantId: string, id: string) {
    return this.tenants.scoped(actor, tenantId, 'customers:write', async (tx) => {
      const result = await tx.customer.updateMany({
        where: { tenantId, id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (!result.count) throw new NotFoundException();
      await this.tenants.audit(tx, actor, tenantId, 'customer.archived', id);
    });
  }
}
