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

  const staffRows = await tx.$queryRaw<Array<{ start_time: string; end_time: string; enabled: boolean }>>`
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
