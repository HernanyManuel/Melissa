import { Dependencies } from '../dependencies';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

const REASONS = ['customer_requested', 'unsupported', 'complaint', 'safety', 'other'] as const;
type HandoffReason = (typeof REASONS)[number];

interface ExistingHandoff {
  conversation_id: string;
  customer_id: string;
  turn_id: string;
  reason: string;
}

function validateArguments(value: JsonObject): JsonObject {
  if (
    Object.keys(value).length !== 1 ||
    typeof value.reason !== 'string' ||
    !REASONS.includes(value.reason as HandoffReason)
  )
    throw new Error('Invalid handoff reason');
  return { reason: value.reason };
}

export class PrismaHumanHandoff {
  constructor(private readonly deps: Dependencies) {}

  async request(
    input: {
      tenantId: string;
      conversationId: string;
      customerId: string;
      turnId: string;
      idempotencyKey: string;
      executionMode: 'live' | 'sandbox';
      reason: HandoffReason;
    },
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (input.executionMode !== 'live') throw new Error('Human handoff is live-only');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;

      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ai_handoff_requests
          (tenant_id, idempotency_key, conversation_id, customer_id, turn_id, reason)
        VALUES
          (${input.tenantId}::uuid, ${input.idempotencyKey}, ${input.conversationId}::uuid,
           ${input.customerId}::uuid, ${input.turnId}::uuid, ${input.reason})
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id
      `;

      if (!inserted.length) {
        const previous = await tx.$queryRaw<ExistingHandoff[]>`
          SELECT conversation_id::text, customer_id::text, turn_id::text, reason
          FROM ai_handoff_requests
          WHERE tenant_id=${input.tenantId}::uuid AND idempotency_key=${input.idempotencyKey}
          LIMIT 1
        `;
        const row = previous[0];
        if (
          !row ||
          row.conversation_id !== input.conversationId ||
          row.customer_id !== input.customerId ||
          row.turn_id !== input.turnId ||
          row.reason !== input.reason
        )
          throw new Error('Idempotency conflict');
        return { status: 'waiting_human', duplicate: true };
      }

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const conversations = await tx.$queryRaw<{ mode: string }[]>`
        SELECT mode
        FROM conversations
        WHERE tenant_id=${input.tenantId}::uuid
          AND id=${input.conversationId}::uuid
          AND customer_id=${input.customerId}::uuid
        FOR UPDATE
      `;
      if (conversations[0]?.mode !== 'AI_ACTIVE') throw new Error('Conversation is not AI active');

      const changed = await tx.$executeRaw`
        UPDATE conversations
        SET mode='WAITING_HUMAN'
        WHERE tenant_id=${input.tenantId}::uuid
          AND id=${input.conversationId}::uuid
          AND customer_id=${input.customerId}::uuid
          AND mode='AI_ACTIVE'
      `;
      if (changed !== 1) throw new Error('Conversation handoff is stale');

      await tx.$executeRaw`
        INSERT INTO audit_events (tenant_id, actor_id, actor_type, action, target_id)
        VALUES (${input.tenantId}::uuid, NULL, 'system', 'ai.handoff_requested', ${input.conversationId}::uuid)
      `;

      return { status: 'waiting_human', duplicate: false };
    });
  }
}

export function registerHumanHandoffTool(
  registry: ToolRegistry,
  handoff: PrismaHumanHandoff,
): void {
  registry.register({
    definition: {
      name: 'human_handoff',
      description:
        'Transfer the current live conversation to a human when the customer asks, the request is unsupported, or human review is required.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: [...REASONS],
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
    effect: 'handoff',
    requiredCapabilities: ['conversation.handoff'],
    supportsIdempotency: true,
    validateArguments,
    execute: (context, arguments_, signal) =>
      handoff.request(
        {
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          customerId: context.customerId,
          turnId: context.turnId,
          idempotencyKey: context.idempotencyKey,
          executionMode: context.executionMode,
          reason: arguments_.reason as HandoffReason,
        },
        signal,
      ),
  });
}
