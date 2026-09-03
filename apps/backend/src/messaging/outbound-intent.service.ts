import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';

export interface MockOutboundInput {
  requestId: string;
  conversationId: string;
  text: string;
}

// Temporary bounded sandbox storage, not a subscription entitlement or dispatch queue.
export const MAX_MOCK_OUTBOUND_INTENTS = 1000;

@Injectable()
export class OutboundIntentService {
  constructor(private readonly tenants: TenantService) {}

  receipt(actor: Actor, tenantId: string, id: string) {
    if (!isUUID(tenantId) || !isUUID(id)) throw new BadRequestException();
    tenantId = tenantId.toLowerCase();
    return this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      const intent = await tx.outboundIntent.findUnique({
        where: { tenantId_id: { tenantId, id: id.toLowerCase() } },
        select: { id: true },
      });
      if (!intent) throw new NotFoundException();
      return { intentId: intent.id, state: 'stored' as const };
    });
  }

  async acceptMock(actor: Actor, tenantId: string, input: MockOutboundInput) {
    if (
      !isUUID(tenantId) ||
      !input ||
      !isUUID(input.requestId) ||
      !isUUID(input.conversationId) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      Array.from(input.text).length > 4096 ||
      /[\u0000\p{Surrogate}]/u.test(input.text)
    )
      throw new BadRequestException();

    tenantId = tenantId.toLowerCase();
    input = {
      ...input,
      requestId: input.requestId.toLowerCase(),
      conversationId: input.conversationId.toLowerCase(),
    };

    const result = await this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      // TenantService revalidates membership under the tenant lock. Concurrent acceptance,
      // channel revocation and customer archival use this same serialization boundary.
      const previous = await tx.outboundIntent.findUnique({
        where: {
          tenantId_actorId_requestId: {
            tenantId,
            actorId: actor.userId,
            requestId: input.requestId,
          },
        },
      });
      if (previous) {
        if (
          previous.conversationId !== input.conversationId ||
          previous.contentText !== input.text
        ) {
          await this.tenants.audit(tx, actor, tenantId, 'outbound.intent_conflict', previous.id);
          return { conflict: true as const };
        }
        // A replay reports stored intent only; it never requeues or promises delivery.
        return { conflict: false as const, intentId: previous.id, duplicate: true };
      }
      const conversation = await tx.conversation.findFirst({
        where: {
          tenantId,
          id: input.conversationId,
          status: { notIn: ['closed', 'archived'] },
          mode: { not: 'CLOSED' },
          customer: { deletedAt: null },
          channelConnection: { mode: 'mock', channelType: 'whatsapp', status: 'active' },
        },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException();
      if ((await tx.outboundIntent.count({ where: { tenantId } })) >= MAX_MOCK_OUTBOUND_INTENTS)
        throw new ConflictException();
      const intent = await tx.outboundIntent.create({
        data: {
          id: randomUUID(),
          tenantId,
          actorId: actor.userId,
          requestId: input.requestId,
          conversationId: conversation.id,
          contentText: input.text,
          providerKey: 'mock',
        },
        select: { id: true },
      });
      await this.tenants.audit(tx, actor, tenantId, 'outbound.intent_stored', intent.id);
      return { conflict: false as const, intentId: intent.id, duplicate: false };
    });
    // Conflict evidence commits before the error is returned; no message content in audit.
    if (result.conflict) throw new ConflictException();
    return { intentId: result.intentId, duplicate: result.duplicate, state: 'stored' as const };
  }
}
