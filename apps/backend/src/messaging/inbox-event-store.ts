import { Prisma } from '@prisma/client';

export const INBOX_EVENT_TYPES = [
  'message.received',
  'conversation.handoff_requested',
  'conversation.takeover',
  'conversation.ai_reactivated',
  'conversation.closed',
] as const;

export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

export interface InboxEventInput {
  tenantId: string;
  conversationId: string;
  eventType: InboxEventType;
  messageId?: string | null;
  actorId?: string | null;
}

export async function appendInboxEvent(
  tx: Prisma.TransactionClient,
  input: InboxEventInput,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO inbox_events (
      tenant_id, event_type, conversation_id, message_id, actor_id
    ) VALUES (
      ${input.tenantId}::uuid,
      ${input.eventType},
      ${input.conversationId}::uuid,
      ${input.messageId ?? null}::uuid,
      ${input.actorId ?? null}::uuid
    )
  `;
}
