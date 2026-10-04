import { ServiceUnavailableException } from '@nestjs/common';
import { Dependencies } from '../dependencies';

// Never infer success from a missing dispatcher record or incomplete commit evidence.
export function checkedReceiptState(
  state: string | undefined,
  hasMessage: boolean,
  processedAt: Date | null,
): string {
  if (
    !state ||
    !['pending', 'processed', 'rejected', 'failed'].includes(state) ||
    (state === 'processed' && (!hasMessage || !processedAt)) ||
    (state !== 'processed' && hasMessage)
  )
    throw new ServiceUnavailableException();
  return state;
}


export type AIAutomaticDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';
export type AIAutomaticDeliveryReceiptResult =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'unknown';

const AI_DELIVERY_STATUS_RANK: Record<AIAutomaticDeliveryStatus, number> = {
  sent: 10,
  delivered: 20,
  read: 30,
  failed: 40,
};

export async function recordAIAutomaticDeliveryReceipt(
  deps: Pick<Dependencies, 'db'>,
  input: {
    tenantId: string;
    providerMessageId: string;
    status: AIAutomaticDeliveryStatus;
    providerTimestamp: Date;
  },
): Promise<AIAutomaticDeliveryReceiptResult> {
  return deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
    const dispatch = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ai_outbound_dispatch
      WHERE tenant_id=${input.tenantId}::uuid
        AND provider_message_id=${input.providerMessageId}
        AND state='accepted'
      LIMIT 1`;
    if (!dispatch[0]) return 'unknown';

    const existing = await tx.$queryRaw<
      Array<{ status: AIAutomaticDeliveryStatus; statusRank: number }>
    >`
      SELECT status, status_rank AS "statusRank"
      FROM ai_outbound_delivery_receipts
      WHERE tenant_id=${input.tenantId}::uuid
        AND provider_message_id=${input.providerMessageId}`;
    const rank = AI_DELIVERY_STATUS_RANK[input.status];
    if (existing[0]?.status === input.status) return 'duplicate';
    if (existing[0] && existing[0].statusRank >= rank) return 'stale';

    await tx.$executeRaw`
      INSERT INTO ai_outbound_delivery_receipts (
        tenant_id, dispatch_id, provider_message_id, status, status_rank,
        provider_timestamp
      ) VALUES (
        ${input.tenantId}::uuid, ${dispatch[0].id}::uuid,
        ${input.providerMessageId}, ${input.status}, ${rank},
        ${input.providerTimestamp}
      )
      ON CONFLICT (tenant_id, provider_message_id) DO UPDATE
      SET status=EXCLUDED.status,
          status_rank=EXCLUDED.status_rank,
          provider_timestamp=EXCLUDED.provider_timestamp,
          updated_at=CURRENT_TIMESTAMP
      WHERE ai_outbound_delivery_receipts.status_rank < EXCLUDED.status_rank`;
    return 'applied';
  });
}
