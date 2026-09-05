import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { MockChannelDto } from './channel.dto';

// Explicit allowlist: secret references and arbitrary provider metadata never reach the client.
const publicFields = {
  id: true,
  displayName: true,
  channelType: true,
  mode: true,
  status: true,
  createdAt: true,
  connectedAt: true,
  disconnectedAt: true,
} satisfies Prisma.ChannelConnectionSelect;

@Injectable()
export class ChannelService {
  constructor(private readonly tenants: TenantService) {}

  list(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'channels:manage', (tx) =>
      tx.channelConnection.findMany({
        where: { tenantId },
        select: publicFields,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  createMock(actor: Actor, tenantId: string, input: MockChannelDto) {
    return this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      // TenantService holds the tenant row lock: concurrent provisioning observes this limit.
      if ((await tx.channelConnection.count({ where: { tenantId } })) >= 100)
        throw new ConflictException();
      const id = randomUUID();
      const channel = await tx.channelConnection.create({
        data: {
          id,
          tenantId,
          channelType: 'whatsapp',
          mode: 'mock',
          displayName: input.displayName,
          externalAccountId: `mock:${id}`,
          externalPhoneId: `mock:${id}`,
        },
        select: publicFields,
      });
      await this.tenants.audit(tx, actor, tenantId, 'channel.mock_created', id);
      return channel;
    });
  }

  disconnect(actor: Actor, tenantId: string, id: string) {
    return this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      const channel = await tx.channelConnection.findUnique({
        where: { tenantId_id: { tenantId, id } },
        select: publicFields,
      });
      if (!channel) throw new NotFoundException();
      if (channel.status === 'disconnected') return channel;
      const updated = await tx.channelConnection.update({
        where: { tenantId_id: { tenantId, id } },
        data: { status: 'disconnected', disconnectedAt: new Date() },
        select: publicFields,
      });
      await this.tenants.audit(tx, actor, tenantId, 'channel.disconnected', id);
      return updated;
    });
  }
}
