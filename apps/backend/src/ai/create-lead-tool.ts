import { createHash, randomUUID } from 'node:crypto';
import { Dependencies } from '../dependencies';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

export interface LeadCreateRequest {
  tenantId: string;
  conversationId: string;
  customerId: string;
  turnId: string;
  expectedModeEpoch: bigint;
  idempotencyKey: string;
  executionMode: 'live' | 'sandbox';
  topic: string;
  details: string;
}

export interface LeadCreator {
  create(input: LeadCreateRequest, signal: AbortSignal): Promise<JsonValue>;
}

interface ExistingLead {
  conversation_id: string;
  customer_id: string;
  turn_id: string;
  arguments_hash: string;
}

function validateArguments(value: JsonObject): JsonObject {
  if (
    Object.keys(value).length !== 2 ||
    typeof value.topic !== 'string' ||
    typeof value.details !== 'string'
  )
    throw new Error('Invalid lead');

  const topic = value.topic.trim();
  const details = value.details.trim();
  if (!topic.length || topic.length > 120) throw new Error('Invalid lead topic');
  if (!details.length || details.length > 1000) throw new Error('Invalid lead details');
  return { topic, details };
}

function argumentsHash(topic: string, details: string): string {
  return createHash('sha256').update(JSON.stringify({ topic, details })).digest('hex');
}

export class PrismaLeadCreator implements LeadCreator {
  constructor(private readonly deps: Dependencies) {}

  async create(input: LeadCreateRequest, signal: AbortSignal): Promise<JsonValue> {
    if (input.executionMode !== 'live') throw new Error('Lead creation is live-only');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const hash = argumentsHash(input.topic, input.details);

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;

      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO leads (
          tenant_id, idempotency_key, conversation_id, customer_id, turn_id,
          arguments_hash, topic, details
        ) VALUES (
          ${input.tenantId}::uuid, ${input.idempotencyKey}, ${input.conversationId}::uuid,
          ${input.customerId}::uuid, ${input.turnId}::uuid, ${hash}, ${input.topic}, ${input.details}
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id::text
      `;

      if (!inserted.length) {
        const previous = await tx.$queryRaw<ExistingLead[]>`
          SELECT conversation_id::text, customer_id::text, turn_id::text, arguments_hash
          FROM leads
          WHERE tenant_id=${input.tenantId}::uuid AND idempotency_key=${input.idempotencyKey}
          LIMIT 1
        `;
        const row = previous[0];
        if (
          !row ||
          row.conversation_id !== input.conversationId ||
          row.customer_id !== input.customerId ||
          row.turn_id !== input.turnId ||
          row.arguments_hash !== hash
        )
          throw new Error('Idempotency conflict');
        return { status: 'created', duplicate: true };
      }

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const conversations = await tx.$queryRaw<Array<{ mode: string; mode_epoch: bigint }>>`
        SELECT mode, mode_epoch
        FROM conversations
        WHERE tenant_id=${input.tenantId}::uuid
          AND id=${input.conversationId}::uuid
          AND customer_id=${input.customerId}::uuid
        FOR UPDATE
      `;
      const conversation = conversations[0];
      if (conversation?.mode !== 'AI_ACTIVE' || conversation.mode_epoch !== input.expectedModeEpoch)
        throw new Error('Lead creation is stale');

      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          tenantId: input.tenantId,
          actorId: null,
          actorType: 'system',
          action: 'ai.lead_created',
          targetId: inserted[0]!.id,
        },
      });

      return { status: 'created', duplicate: false };
    });
  }
}

export function registerCreateLeadTool(registry: ToolRegistry, creator: LeadCreator): void {
  registry.register({
    definition: {
      name: 'create_lead',
      description:
        'Create a follow-up lead for the customer in the current live conversation. Do not copy phone or email; the customer is linked by trusted server context.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', minLength: 1, maxLength: 120 },
          details: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['topic', 'details'],
        additionalProperties: false,
      },
    },
    effect: 'write',
    requiredCapabilities: ['customer.lead.create'],
    supportsIdempotency: true,
    validateArguments,
    execute: (context, arguments_, signal) =>
      creator.create(
        {
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          customerId: context.customerId,
          turnId: context.turnId,
          expectedModeEpoch: context.expectedModeEpoch,
          idempotencyKey: context.idempotencyKey,
          executionMode: context.executionMode,
          topic: arguments_.topic as string,
          details: arguments_.details as string,
        },
        signal,
      ),
  });
}
