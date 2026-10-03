import { Injectable } from '@nestjs/common';
import { Dependencies } from '../dependencies';
import { ConversationFence } from './conversation-engine';

@Injectable()
export class PrismaConversationFence implements ConversationFence {
  constructor(private readonly deps: Dependencies) {}

  isCurrent(
    tenantId: string,
    conversationId: string,
    customerId: string,
    expectedModeEpoch: bigint,
  ): Promise<boolean> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return (
        (await tx.conversation.count({
          where: {
            tenantId,
            id: conversationId,
            customerId,
            mode: 'AI_ACTIVE',
            modeEpoch: expectedModeEpoch,
          },
        })) === 1
      );
    });
  }
}
