import { createHash, randomUUID } from 'node:crypto';
import { Dependencies } from '../dependencies';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

const LANGUAGES = ['pt', 'en', 'es', 'fr', 'de', 'it'] as const;
type Language = (typeof LANGUAGES)[number];

type CustomerPatch = {
  displayName?: string;
  email?: string | null;
  language?: Language;
};

interface ExistingUpdate {
  conversation_id: string;
  customer_id: string;
  turn_id: string;
  arguments_hash: string;
}

function validateArguments(value: JsonObject): JsonObject {
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !['displayName', 'email', 'language'].includes(key)))
    throw new Error('Invalid customer update');

  const normalized: JsonObject = {};
  if ('displayName' in value) {
    if (typeof value.displayName !== 'string') throw new Error('Invalid display name');
    const displayName = value.displayName.trim();
    if (!displayName.length || displayName.length > 160) throw new Error('Invalid display name');
    normalized.displayName = displayName;
  }
  if ('email' in value) {
    if (value.email !== null && typeof value.email !== 'string') throw new Error('Invalid email');
    if (typeof value.email === 'string') {
      const email = value.email.trim().toLowerCase();
      if (
        !email.length ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      )
        throw new Error('Invalid email');
      normalized.email = email;
    } else normalized.email = null;
  }
  if ('language' in value) {
    if (typeof value.language !== 'string' || !LANGUAGES.includes(value.language as Language))
      throw new Error('Invalid language');
    normalized.language = value.language;
  }
  return normalized;
}

function patchHash(patch: Readonly<CustomerPatch>): string {
  const canonical = JSON.stringify({
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(patch.language !== undefined ? { language: patch.language } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class PrismaCustomerUpdater {
  constructor(private readonly deps: Dependencies) {}

  async update(
    input: {
      tenantId: string;
      conversationId: string;
      customerId: string;
      turnId: string;
      expectedModeEpoch: bigint;
      idempotencyKey: string;
      executionMode: 'live' | 'sandbox';
      patch: CustomerPatch;
    },
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (input.executionMode !== 'live') throw new Error('Customer update is live-only');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const argumentsHash = patchHash(input.patch);

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;

      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ai_customer_update_requests
          (tenant_id, idempotency_key, conversation_id, customer_id, turn_id, arguments_hash)
        VALUES
          (${input.tenantId}::uuid, ${input.idempotencyKey}, ${input.conversationId}::uuid,
           ${input.customerId}::uuid, ${input.turnId}::uuid, ${argumentsHash})
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id
      `;

      if (!inserted.length) {
        const previous = await tx.$queryRaw<ExistingUpdate[]>`
          SELECT conversation_id::text, customer_id::text, turn_id::text, arguments_hash
          FROM ai_customer_update_requests
          WHERE tenant_id=${input.tenantId}::uuid AND idempotency_key=${input.idempotencyKey}
          LIMIT 1
        `;
        const row = previous[0];
        if (
          !row ||
          row.conversation_id !== input.conversationId ||
          row.customer_id !== input.customerId ||
          row.turn_id !== input.turnId ||
          row.arguments_hash !== argumentsHash
        )
          throw new Error('Idempotency conflict');
        return { status: 'updated', duplicate: true };
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
        throw new Error('Customer update is stale');

      const updated = await tx.customer.updateMany({
        where: { tenantId: input.tenantId, id: input.customerId, deletedAt: null },
        data: input.patch,
      });
      if (updated.count !== 1) throw new Error('Customer update is stale');

      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          tenantId: input.tenantId,
          actorId: null,
          actorType: 'system',
          action: 'ai.customer_updated',
          targetId: input.customerId,
        },
      });

      return { status: 'updated', duplicate: false };
    });
  }
}

export function registerUpdateCustomerTool(registry: ToolRegistry, updater: PrismaCustomerUpdater): void {
  registry.register({
    definition: {
      name: 'update_customer',
      description:
        'Update allowed profile fields for the customer in the current live conversation. Phone number, consent flags and internal notes cannot be changed.',
      inputSchema: {
        type: 'object',
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 160 },
          email: { type: ['string', 'null'], maxLength: 254 },
          language: { type: 'string', enum: [...LANGUAGES] },
        },
        additionalProperties: false,
        minProperties: 1,
      },
    },
    effect: 'write',
    requiredCapabilities: ['customer.profile.write'],
    supportsIdempotency: true,
    validateArguments,
    execute: (context, arguments_, signal) =>
      updater.update(
        {
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          customerId: context.customerId,
          turnId: context.turnId,
          expectedModeEpoch: context.expectedModeEpoch,
          idempotencyKey: context.idempotencyKey,
          executionMode: context.executionMode,
          patch: arguments_ as CustomerPatch,
        },
        signal,
      ),
  });
}
