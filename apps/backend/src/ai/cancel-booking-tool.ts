import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import { JsonObject, JsonValue } from './ai-provider';
import { ToolRegistry } from './tool-registry';

export interface CancelBookingRequest {
  tenantId: string;
  conversationId: string;
  customerId: string;
  turnId: string;
  expectedModeEpoch: bigint;
  idempotencyKey: string;
  executionMode: 'live' | 'sandbox';
  bookingId: string;
  reason?: string;
  confirmed: true;
}

export type CancelBookingResult =
  | {
      status: 'cancelled';
      bookingId: string;
      cancelledAt: string;
      duplicate: boolean;
      alreadyCancelled: boolean;
    }
  | { status: 'not_found' };

export interface BookingCanceller {
  cancel(input: CancelBookingRequest, signal: AbortSignal): Promise<CancelBookingResult>;
}

interface ExistingOperation {
  booking_id: string;
  conversation_id: string;
  customer_id: string;
  turn_id: string;
  operation: string;
  arguments_hash: string;
}

interface BookingRow {
  id: string;
  status: string;
  cancelled_at: Date | null;
}

function validateArguments(value: JsonObject): JsonObject {
  const keys = Object.keys(value);
  if (keys.length < 2 || keys.length > 3) throw new Error('Invalid cancellation request');
  if (typeof value.bookingId !== 'string' || !isUUID(value.bookingId))
    throw new Error('Invalid booking ID');
  if (value.confirmed !== true) throw new Error('Cancellation requires explicit confirmation');
  if (value.reason !== undefined && typeof value.reason !== 'string')
    throw new Error('Invalid cancellation reason');
  for (const key of keys) {
    if (!['bookingId', 'reason', 'confirmed'].includes(key))
      throw new Error('Invalid cancellation request');
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : undefined;
  if (reason !== undefined && (!reason.length || reason.length > 500))
    throw new Error('Invalid cancellation reason');
  return reason === undefined
    ? { bookingId: value.bookingId, confirmed: true }
    : { bookingId: value.bookingId, reason, confirmed: true };
}

function argumentsHash(input: CancelBookingRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        bookingId: input.bookingId,
        reason: input.reason ?? null,
        confirmed: true,
      }),
    )
    .digest('hex');
}

function toJson(result: CancelBookingResult): JsonObject {
  if (result.status === 'not_found') return { status: 'not_found' };
  return {
    status: result.status,
    bookingId: result.bookingId,
    cancelledAt: result.cancelledAt,
    duplicate: result.duplicate,
    alreadyCancelled: result.alreadyCancelled,
  };
}

export class PrismaBookingCanceller implements BookingCanceller {
  constructor(private readonly deps: Dependencies) {}

  async cancel(input: CancelBookingRequest, signal: AbortSignal): Promise<CancelBookingResult> {
    if (input.executionMode !== 'live') throw new Error('Booking cancellation is live-only');
    if (input.confirmed !== true) throw new Error('Cancellation requires explicit confirmation');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const hash = argumentsHash(input);

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;

      const replay = await tx.$queryRaw<ExistingOperation[]>`
        SELECT booking_id::text, conversation_id::text, customer_id::text, turn_id::text,
          operation, arguments_hash
        FROM booking_operations
        WHERE tenant_id=${input.tenantId}::uuid AND idempotency_key=${input.idempotencyKey}
        LIMIT 1
      `;
      if (replay.length) {
        const row = replay[0]!;
        if (
          row.booking_id !== input.bookingId ||
          row.conversation_id !== input.conversationId ||
          row.customer_id !== input.customerId ||
          row.turn_id !== input.turnId ||
          row.operation !== 'cancel' ||
          row.arguments_hash !== hash
        )
          throw new Error('Idempotency conflict');
        const bookings = await tx.$queryRaw<BookingRow[]>`
          SELECT id::text, status, cancelled_at
          FROM bookings
          WHERE tenant_id=${input.tenantId}::uuid AND id=${input.bookingId}::uuid
            AND customer_id=${input.customerId}::uuid
          LIMIT 1
        `;
        const booking = bookings[0];
        if (!booking || booking.status !== 'cancelled' || !booking.cancelled_at)
          throw new Error('Cancellation replay is inconsistent');
        return {
          status: 'cancelled',
          bookingId: booking.id,
          cancelledAt: booking.cancelled_at.toISOString(),
          duplicate: true,
          alreadyCancelled: false,
        };
      }

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
        throw new Error('Booking cancellation is stale');
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const bookings = await tx.$queryRaw<BookingRow[]>`
        SELECT id::text, status, cancelled_at
        FROM bookings
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.bookingId}::uuid
          AND customer_id=${input.customerId}::uuid
        FOR UPDATE
      `;
      const booking = bookings[0];
      if (!booking) return { status: 'not_found' };
      if (booking.status === 'cancelled') {
        if (!booking.cancelled_at) throw new Error('Cancelled booking is inconsistent');
        return {
          status: 'cancelled',
          bookingId: booking.id,
          cancelledAt: booking.cancelled_at.toISOString(),
          duplicate: false,
          alreadyCancelled: true,
        };
      }

      const operations = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO booking_operations (
          tenant_id, booking_id, conversation_id, customer_id, turn_id,
          idempotency_key, operation, arguments_hash
        ) VALUES (
          ${input.tenantId}::uuid, ${input.bookingId}::uuid, ${input.conversationId}::uuid,
          ${input.customerId}::uuid, ${input.turnId}::uuid, ${input.idempotencyKey},
          'cancel', ${hash}
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id::text
      `;
      if (!operations.length) throw new Error('Cancellation operation conflict');

      const cancelledAt = new Date();
      await tx.$executeRaw`
        UPDATE bookings
        SET status='cancelled', cancelled_at=${cancelledAt}, cancellation_reason=${input.reason ?? null},
          version=version+1, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${input.tenantId}::uuid AND id=${input.bookingId}::uuid
          AND customer_id=${input.customerId}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO booking_outbox (tenant_id, booking_id, event_type)
        VALUES (${input.tenantId}::uuid, ${input.bookingId}::uuid, 'cancelled')
        ON CONFLICT (tenant_id, booking_id, event_type) DO NOTHING
      `;
      await tx.auditEvent.create({
        data: {
          id: randomUUID(),
          tenantId: input.tenantId,
          actorId: null,
          actorType: 'system',
          action: 'ai.booking_cancelled',
          targetId: input.bookingId,
        },
      });

      return {
        status: 'cancelled',
        bookingId: input.bookingId,
        cancelledAt: cancelledAt.toISOString(),
        duplicate: false,
        alreadyCancelled: false,
      };
    });
  }
}

export function registerCancelBookingTool(
  registry: ToolRegistry,
  canceller: BookingCanceller,
): void {
  registry.register({
    definition: {
      name: 'cancel_booking',
      description:
        'Cancel one booking belonging to the current customer only after explicit confirmation. Never claim cancellation unless this tool returns status cancelled.',
      inputSchema: {
        type: 'object',
        properties: {
          bookingId: { type: 'string', format: 'uuid' },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
          confirmed: { type: 'boolean', enum: [true] },
        },
        required: ['bookingId', 'confirmed'],
        additionalProperties: false,
      },
    },
    effect: 'write',
    requiredCapabilities: ['booking.cancel'],
    supportsIdempotency: true,
    validateArguments,
    execute: async (context, arguments_, signal): Promise<JsonValue> =>
      toJson(
        await canceller.cancel(
          {
            tenantId: context.tenantId,
            conversationId: context.conversationId,
            customerId: context.customerId,
            turnId: context.turnId,
            expectedModeEpoch: context.expectedModeEpoch,
            idempotencyKey: context.idempotencyKey,
            executionMode: context.executionMode,
            bookingId: arguments_.bookingId as string,
            ...(arguments_.reason === undefined ? {} : { reason: arguments_.reason as string }),
            confirmed: true,
          },
          signal,
        ),
      ),
  });
}
