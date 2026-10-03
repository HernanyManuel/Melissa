import { Prisma } from '@prisma/client';

export type BookingMutation = 'cancel' | 'reschedule';
export type BookingPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'disabled' | 'minimum_notice';
      minimumNoticeMinutes: number;
    };

export interface BookingCreationWindow {
  minimumNoticeMinutes: number;
  maximumHorizonDays: number | null;
  earliestStartsAt: Date;
  latestStartsAt: Date | null;
}

export type BookingCreationPolicyDecision =
  | { allowed: true; window: BookingCreationWindow }
  | {
      allowed: false;
      reason: 'minimum_notice' | 'maximum_horizon';
      minimumNoticeMinutes: number;
      maximumHorizonDays: number | null;
    };

interface PolicyRow {
  cancellation_enabled: boolean;
  cancellation_min_notice_minutes: number;
  rescheduling_enabled: boolean;
  rescheduling_min_notice_minutes: number;
}

interface CreationPolicyRow {
  creation_min_notice_minutes: number;
  creation_max_horizon_days: number | null;
}

export async function readBookingCreationWindowInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<BookingCreationWindow> {
  const [policy] = await tx.$queryRaw<CreationPolicyRow[]>`
    SELECT creation_min_notice_minutes, creation_max_horizon_days
    FROM booking_policies
    WHERE tenant_id=${tenantId}::uuid
    LIMIT 1
  `;
  const minimumNoticeMinutes = policy?.creation_min_notice_minutes ?? 0;
  const maximumHorizonDays = policy?.creation_max_horizon_days ?? null;

  const [bounds] = await tx.$queryRaw<
    Array<{ earliest_starts_at: Date; latest_starts_at: Date | null }>
  >`
    SELECT
      CURRENT_TIMESTAMP + make_interval(mins => ${minimumNoticeMinutes}::int) AS earliest_starts_at,
      CASE
        WHEN ${maximumHorizonDays}::int IS NULL THEN NULL
        ELSE CURRENT_TIMESTAMP + make_interval(days => ${maximumHorizonDays}::int)
      END AS latest_starts_at
  `;
  if (!bounds) throw new Error('Booking creation window is unavailable');

  return {
    minimumNoticeMinutes,
    maximumHorizonDays,
    earliestStartsAt: bounds.earliest_starts_at,
    latestStartsAt: bounds.latest_starts_at,
  };
}

export async function evaluateBookingCreationPolicyInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  startsAt: Date,
): Promise<BookingCreationPolicyDecision> {
  const window = await readBookingCreationWindowInTransaction(tx, tenantId);
  if (startsAt.getTime() < window.earliestStartsAt.getTime()) {
    return {
      allowed: false,
      reason: 'minimum_notice',
      minimumNoticeMinutes: window.minimumNoticeMinutes,
      maximumHorizonDays: window.maximumHorizonDays,
    };
  }
  if (window.latestStartsAt && startsAt.getTime() > window.latestStartsAt.getTime()) {
    return {
      allowed: false,
      reason: 'maximum_horizon',
      minimumNoticeMinutes: window.minimumNoticeMinutes,
      maximumHorizonDays: window.maximumHorizonDays,
    };
  }
  return { allowed: true, window };
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
