import { PrismaClient } from '@prisma/client';
import { isUUID } from 'class-validator';
import { MockMessagingProvider } from '../channels/mock-messaging-provider';
import { allows } from '../tenancy/permissions';

// Internal only. Never accept this tenant argument from an HTTP request or queue job.
// A future dispatcher must resolve it from an authoritative database envelope.
export class OutboundMockProcessor {
  constructor(
    private readonly db: PrismaClient,
    private readonly providerFactory: () => MockMessagingProvider = () =>
      new MockMessagingProvider(),
  ) {}

  async process(tenantId: string, id: string) {
    if (!isUUID(tenantId) || !isUUID(id)) throw new Error('Invalid internal outbound identity');
    tenantId = tenantId.toLowerCase();
    id = id.toLowerCase();
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${tenantId}::uuid FOR UPDATE`;
      const identity = { tenantId_id: { tenantId, id } };
      const intent = await tx.outboundIntent.findUnique({ where: identity });
      if (!intent) return null;
      const previous = await tx.outboundMockResult.findUnique({ where: identity });
      if (previous) return previous;
      const membership = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: intent.actorId } },
      });
      const conversation = await tx.conversation.findFirst({
        where: {
          tenantId,
          id: intent.conversationId,
          status: { notIn: ['closed', 'archived'] },
          mode: { not: 'CLOSED' },
          customer: { deletedAt: null },
          channelConnection: { mode: 'mock', channelType: 'whatsapp', status: 'active' },
        },
        select: { customerId: true },
      });
      const authorized =
        intent.providerKey === 'mock' &&
        membership?.active &&
        allows(membership.role, 'channels:manage') &&
        conversation;
      let providerMessageId: string | null = null;
      if (authorized) {
        // Only the network-free mock may run within this database transaction.
        // A fresh instance bounds memory; persistent results handle restart/retry.
        const provider = this.providerFactory();
        if (provider.key !== 'mock') throw new Error('Mock provider required');
        const delivery = await provider.sendText({
          attemptId: id,
          recipientReference: authorized.customerId,
          text: intent.contentText,
        });
        if (delivery.providerMessageId !== `mock:${id}`) throw new Error('Invalid mock receipt');
        providerMessageId = delivery.providerMessageId;
      }
      const state = providerMessageId ? 'mock_accepted' : 'rejected';
      const result = await tx.outboundMockResult.create({
        data: { tenantId, id, state, providerMessageId },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorId: intent.actorId,
          actorType: 'user',
          action: `outbound.${state === 'rejected' ? 'mock_rejected' : state}`,
          targetId: id,
        },
      });
      return result;
    });
  }
}
