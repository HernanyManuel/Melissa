import { Prisma } from '@prisma/client';

export type BookingMutation = 'cancel' | 'reschedule';
export type BookingPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'disabled' | 'minimum_notice';
      minimumNoticeMinutes: number;
    };

interface PolicyRow {
  cancellation_enabled: boolean;
  cancellation_min_notice_minutes: number;
  rescheduling_enabled: boolean;
  rescheduling_min_notice_minutes: number;
}

export async function evaluateBookingMutationPolicyInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  mutation: BookingMutation,
  startsAt: Date,
): Promise<BookingPolicyDecision> {
  await tx.$executeRaw`
    INSERT INTO booking_policies (tenant_id)
    VALUES (${tenantId}::uuid)
    ON CONFLICT (tenant_id) DO NOTHING
  `;

  const [policy] = await tx.$queryRaw<PolicyRow[]>`
    SELECT cancellation_enabled, cancellation_min_notice_minutes,
      rescheduling_enabled, rescheduling_min_notice_minutes
    FROM booking_policies
    WHERE tenant_id=${tenantId}::uuid
    FOR SHARE
  `;
  if (!policy) throw new Error('Booking policy is unavailable');

  const enabled = mutation === 'cancel' ? policy.cancellation_enabled : policy.rescheduling_enabled;
  const minimumNoticeMinutes =
    mutation === 'cancel'
      ? policy.cancellation_min_notice_minutes
      : policy.rescheduling_min_notice_minutes;
  if (!enabled) return { allowed: false, reason: 'disabled', minimumNoticeMinutes };

  const [notice] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT ${startsAt}::timestamptz >=
      CURRENT_TIMESTAMP + make_interval(mins => ${minimumNoticeMinutes}::int) AS allowed
  `;
  if (notice?.allowed !== true)
    return { allowed: false, reason: 'minimum_notice', minimumNoticeMinutes };

  return { allowed: true };
}
