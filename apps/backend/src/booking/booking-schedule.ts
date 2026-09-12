import { Prisma } from '@prisma/client';

export interface BookingPeriod {
  startTime: string;
  endTime: string;
}

export function validateBookingDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid booking date');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error('Invalid booking date');
}

export async function localBookingDateInTransaction(
  tx: Prisma.TransactionClient,
  startsAt: Date,
  timezone: string,
): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ local_date: string }>>`
    SELECT to_char(${startsAt}::timestamptz AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS local_date
  `;
  if (!row) throw new Error('Booking time is unavailable');
  return row.local_date;
}

export async function effectiveBookingPeriodsInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  date: string,
  staffId?: string | null,
): Promise<BookingPeriod[]> {
  validateBookingDate(date);
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();

  const exception = await tx.scheduleException.findFirst({
    where: { tenantId, date: day },
    select: { closed: true, startTime: true, endTime: true },
  });
  if (exception?.closed) return [];

  const businessPeriods: BookingPeriod[] =
    exception?.startTime && exception.endTime
      ? [{ startTime: exception.startTime, endTime: exception.endTime }]
      : await tx.businessHour.findMany({
          where: { tenantId, weekday, enabled: true },
          select: { startTime: true, endTime: true },
          orderBy: { startTime: 'asc' },
          take: 20,
        });

  if (!staffId || !businessPeriods.length) return businessPeriods;

  const staffRows = await tx.$queryRaw<
    Array<{ start_time: string; end_time: string; enabled: boolean }>
  >`
    SELECT start_time, end_time, enabled
    FROM staff_hours
    WHERE tenant_id=${tenantId}::uuid AND staff_id=${staffId}::uuid AND weekday=${weekday}
    ORDER BY start_time, id
    LIMIT 20
  `;
  if (!staffRows.length) return businessPeriods;

  const enabledStaffPeriods = staffRows.filter((row) => row.enabled);
  if (!enabledStaffPeriods.length) return [];

  const intersections = await tx.$queryRaw<Array<{ start_time: string; end_time: string }>>`
    WITH business(start_time, end_time) AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(businessPeriods)}::jsonb)
        AS x("startTime" text, "endTime" text)
    ), staff(start_time, end_time) AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(
        enabledStaffPeriods.map((period) => ({
          startTime: period.start_time,
          endTime: period.end_time,
        })),
      )}::jsonb) AS x("startTime" text, "endTime" text)
    )
    SELECT
      to_char(GREATEST(business.start_time::time, staff.start_time::time), 'HH24:MI') AS start_time,
      to_char(LEAST(business.end_time::time, staff.end_time::time), 'HH24:MI') AS end_time
    FROM business
    CROSS JOIN staff
    WHERE GREATEST(business.start_time::time, staff.start_time::time) <
      LEAST(business.end_time::time, staff.end_time::time)
    ORDER BY start_time, end_time
  `;

  return intersections.map((period) => ({
    startTime: period.start_time,
    endTime: period.end_time,
  }));
}

export async function isBookingCandidateInPeriods(
  tx: Prisma.TransactionClient,
  startsAt: Date,
  date: string,
  periods: readonly BookingPeriod[],
  timezone: string,
  durationMinutes: number,
): Promise<boolean> {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) return false;
  for (const period of periods) {
    const [row] = await tx.$queryRaw<Array<{ valid: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM generate_series(
          (${date}::date + ${period.startTime}::time) AT TIME ZONE ${timezone},
          ((${date}::date + ${period.endTime}::time) AT TIME ZONE ${timezone}) -
            make_interval(mins => ${durationMinutes}::int),
          interval '15 minutes'
        ) AS candidate
        WHERE candidate=${startsAt}::timestamptz
      ) AS valid
    `;
    if (row?.valid) return true;
  }
  return false;
}

export async function isBookingResourceUnblockedInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  resourceId: string,
  startsAt: Date,
  durationMinutes: number,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number,
): Promise<boolean> {
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    !Number.isInteger(bufferBeforeMinutes) ||
    bufferBeforeMinutes < 0 ||
    !Number.isInteger(bufferAfterMinutes) ||
    bufferAfterMinutes < 0
  )
    return false;

  const calendarConnections = await tx.$queryRaw<Array<{ id: string; fresh: boolean }>>`
    SELECT
      connection.id::text,
      connection.status='connected'
        AND connection.last_success_at IS NOT NULL
        AND connection.last_success_at <= CURRENT_TIMESTAMP
        AND connection.last_success_at +
          make_interval(secs => connection.freshness_limit_seconds) >= CURRENT_TIMESTAMP
        AND connection.coverage_starts_at IS NOT NULL
        AND connection.coverage_ends_at IS NOT NULL
        AND connection.coverage_starts_at <=
          ${startsAt}::timestamptz - make_interval(mins => ${bufferBeforeMinutes}::int)
        AND connection.coverage_ends_at >=
          ${startsAt}::timestamptz +
            make_interval(mins => ${durationMinutes + bufferAfterMinutes}::int) AS fresh
    FROM calendar_connections connection
    JOIN booking_resources resource
      ON resource.tenant_id=connection.tenant_id
    WHERE connection.tenant_id=${tenantId}::uuid
      AND resource.tenant_id=${tenantId}::uuid
      AND resource.id=${resourceId}::uuid
      AND connection.staff_id IS NOT DISTINCT FROM resource.staff_id
    ORDER BY connection.id
    FOR SHARE OF connection
  `;
  if (calendarConnections.some((connection) => !connection.fresh)) return false;

  const [row] = await tx.$queryRaw<Array<{ available: boolean }>>`
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM resource_blocks block
        WHERE block.tenant_id=${tenantId}::uuid
          AND block.resource_id=${resourceId}::uuid
          AND tstzrange(block.starts_at, block.ends_at, '[)') &&
            tstzrange(
              ${startsAt}::timestamptz - make_interval(mins => ${bufferBeforeMinutes}::int),
              ${startsAt}::timestamptz +
                make_interval(mins => ${durationMinutes + bufferAfterMinutes}::int),
              '[)'
            )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM calendar_busy_intervals busy
        JOIN calendar_connections connection
          ON connection.tenant_id=busy.tenant_id AND connection.id=busy.connection_id
        JOIN booking_resources resource
          ON resource.tenant_id=connection.tenant_id
        WHERE connection.tenant_id=${tenantId}::uuid
          AND resource.tenant_id=${tenantId}::uuid
          AND resource.id=${resourceId}::uuid
          AND connection.staff_id IS NOT DISTINCT FROM resource.staff_id
          AND busy.sync_version=connection.sync_version
          AND tstzrange(busy.starts_at, busy.ends_at, '[)') &&
            tstzrange(
              ${startsAt}::timestamptz - make_interval(mins => ${bufferBeforeMinutes}::int),
              ${startsAt}::timestamptz +
                make_interval(mins => ${durationMinutes + bufferAfterMinutes}::int),
              '[)'
            )
      ) AS available
  `;
  return row?.available === true;
}
