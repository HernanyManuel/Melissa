import { Dependencies } from '../dependencies';
import { allows } from '../tenancy/permissions';
import { ConversationLock } from './conversation-lock';

export class InboundProcessor {
  constructor(private readonly deps: Dependencies) {}

  async process(id: string): Promise<void> {
    // Job supplies only an opaque ID. Tenant is obtained from the committed DB envelope.
    const route = await this.deps.db.inboundDispatch.findUnique({ where: { id } });
    if (!route || route.state !== 'pending') return;
    const scope = await this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${route.tenantId},true)`;
      return tx.inboundOutbox.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: route.tenantId, id } },
        select: { channelId: true, customerId: true },
      });
    });
    // Stable identity exists before the conversation row: tenant + channel + customer.
    const key = `conversation:${route.tenantId}:${scope.channelId}:${scope.customerId}`;
    await new ConversationLock(this.deps.redis).run(key, async (assertOwned) => {
      await this.deps.db.$transaction(async (tx) => {
        const tenantId = route.tenantId;
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
        await tx.$queryRaw`SELECT id FROM tenants WHERE id=${tenantId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM inbound_dispatch WHERE id=${id}::uuid FOR UPDATE`;
        const current = await tx.inboundDispatch.findUniqueOrThrow({ where: { id } });
        if (current.state !== 'pending' || current.nextAttemptAt > new Date()) return;
        const input = await tx.inboundOutbox.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id } },
        });
        if (input.batchId) {
          const batch = await tx.inboundBatch.findUniqueOrThrow({
            where: { tenantId_id: { tenantId, id: input.batchId } },
          });
          if (batch.dueAt > new Date()) return;
          if (!batch.sealedAt)
            await tx.inboundBatch.update({
              where: { tenantId_id: { tenantId, id: batch.id } },
              data: { sealedAt: new Date() },
            });
        }
        const channel = await tx.channelConnection.findFirst({
          where: {
            tenantId,
            id: input.channelId,
            mode: input.origin === 'mock' ? 'mock' : 'live',
            status: 'active',
          },
        });
        const customer = await tx.customer.findFirst({
          where: { tenantId, id: input.customerId, deletedAt: null },
        });
        const membership = input.actorId
          ? await tx.membership.findUnique({
              where: { tenantId_userId: { tenantId, userId: input.actorId } },
            })
          : null;
        let authorized =
          input.origin === 'mock' &&
          !!membership?.active &&
          allows(membership.role, 'channels:manage');
        if (
          input.origin === 'whatsapp' &&
          input.actorId === null &&
          input.integrationKey &&
          channel?.channelType === 'whatsapp'
        ) {
          const bindings = await tx.$queryRaw<{ channel_id: string }[]>`
            SELECT channel_id FROM whatsapp_routes WHERE integration_key=${input.integrationKey}
            AND tenant_id=${tenantId}::uuid AND channel_id=${channel.id}::uuid
            AND account_id=${channel.externalAccountId} AND phone_id=${channel.externalPhoneId}`;
          authorized = bindings.length === 1;
        }
        const actorType = input.origin === 'mock' ? 'user' : 'whatsapp';
        if (!channel || !customer || !authorized) {
          await tx.inboundDispatch.update({ where: { id }, data: { state: 'rejected' } });
          await tx.inboundOutbox.update({
            where: { tenantId_id: { tenantId, id } },
            data: { contentText: null },
          });
          await tx.auditEvent.create({
            data: {
              tenantId,
              actorId: input.actorId,
              actorType,
              action: `message.${input.origin}_rejected`,
              targetId: id,
            },
          });
          await assertOwned();
          return;
        }
        if (input.contentText === null) throw new Error('Missing pending payload');
        const event = await tx.externalEvent.findUniqueOrThrow({
          where: { tenantId_id: { tenantId, id } },
        });
        const conversation = await tx.conversation.upsert({
          where: {
            tenantId_channelConnectionId_customerId: {
              tenantId,
              channelConnectionId: channel.id,
              customerId: customer.id,
            },
          },
          create: {
            tenantId,
            channelConnectionId: channel.id,
            customerId: customer.id,
            language: customer.language,
            lastMessageAt: event.createdAt,
          },
          update: {},
        });
        // Jobs can be delivered out of order; never move last-message time backwards.
        await tx.conversation.updateMany({
          where: { tenantId, id: conversation.id, lastMessageAt: { lt: event.createdAt } },
          data: { lastMessageAt: event.createdAt },
        });
        const message = await tx.message.create({
          data: {
            tenantId,
            conversationId: conversation.id,
            externalEventId: id,
            contentText: input.contentText,
            createdAt: event.createdAt,
            batchId: input.batchId,
          },
        });
        await tx.externalEvent.update({
          where: { tenantId_id: { tenantId, id } },
          data: { processedAt: new Date() },
        });
        await tx.inboundDispatch.update({ where: { id }, data: { state: 'processed' } });
        await tx.inboundOutbox.update({
          where: { tenantId_id: { tenantId, id } },
          data: { contentText: null },
        });
        await tx.auditEvent.create({
          data: {
            tenantId,
            actorId: input.actorId,
            actorType,
            action: `message.${input.origin}_received`,
            targetId: message.id,
          },
        });
        await assertOwned();
      });
    });
  }

  async recordFailure(id: string): Promise<void> {
    const route = await this.deps.db.inboundDispatch.findUnique({ where: { id } });
    if (!route) return;
    await this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${route.tenantId},true)`;
      await tx.$queryRaw`SELECT id FROM inbound_dispatch WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.inboundDispatch.findUniqueOrThrow({ where: { id } });
      if (current.state !== 'pending') return;
      const attempts = current.attempts + 1;
      await tx.inboundDispatch.update({
        where: { id },
        data: {
          attempts,
          state: attempts >= 5 ? 'failed' : 'pending',
          nextAttemptAt: new Date(Date.now() + 1000 * 2 ** attempts),
        },
      });
    });
  }
}
