import { Prisma } from '@prisma/client';
import { Dependencies } from '../dependencies';

export interface AvailabilityRequest {
  tenantId: string;
  serviceId: string;
  date: string;
  staffId?: string;
}

export interface BookingSlot {
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityResult {
  timezone: string;
  resourceId: string;
  staffId: string | null;
  slots: BookingSlot[];
}

interface Period {
  startTime: string;
  endTime: string;
}

function validateDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('Invalid booking date');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error('Invalid booking date');
}

export class BookingEngine {
  constructor(private readonly deps: Dependencies) {}

  async ensureDefaultResource(tenantId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return this.ensureDefaultResourceInTransaction(tx, tenantId);
    });
  }

  async availableSlots(
    input: AvailabilityRequest,
    signal: AbortSignal,
  ): Promise<AvailabilityResult> {
    validateDate(input.date);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const tenant = await tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: { timezone: true },
      });
      if (!tenant) throw new Error('Booking tenant is unavailable');

      const service = await tx.businessService.findFirst({
        where: {
          tenantId: input.tenantId,
          id: input.serviceId,
          active: true,
          deletedAt: null,
          bookingEnabled: true,
        },
        select: {
          durationMinutes: true,
          bufferBeforeMinutes: true,
          bufferAfterMinutes: true,
        },
      });
      if (!service) throw new Error('Booking service is unavailable');

      let resourceId: string;
      let durationMinutes = service.durationMinutes;
      if (input.staffId) {
        const staffService = await tx.staffService.findFirst({
          where: {
            tenantId: input.tenantId,
            staffId: input.staffId,
            serviceId: input.serviceId,
            active: true,
            staff: { is: { active: true } },
          },
          select: { customDurationMinutes: true, staff: { select: { name: true } } },
        });
        if (!staffService) throw new Error('Booking staff is unavailable');
        durationMinutes = staffService.customDurationMinutes ?? durationMinutes;
        resourceId = await this.ensureStaffResourceInTransaction(
          tx,
          input.tenantId,
          input.staffId,
          staffService.staff.name,
        );
      } else {
        resourceId = await this.ensureDefaultResourceInTransaction(tx, input.tenantId);
      }

      const day = new Date(`${input.date}T00:00:00Z`);
      const weekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
      const exception = await tx.scheduleException.findFirst({
        where: { tenantId: input.tenantId, date: day },
        select: { closed: true, startTime: true, endTime: true },
      });
      if (exception?.closed) {
        return { timezone: tenant.timezone, resourceId, staffId: input.staffId ?? null, slots: [] };
      }

      let periods: Period[];
      if (exception?.startTime && exception.endTime) {
        periods = [{ startTime: exception.startTime, endTime: exception.endTime }];
      } else {
        periods = await tx.businessHour.findMany({
          where: { tenantId: input.tenantId, weekday, enabled: true },
          select: { startTime: true, endTime: true },
          orderBy: { startTime: 'asc' },
          take: 10,
        });
      }

      const slots: BookingSlot[] = [];
      for (const period of periods) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const rows = await tx.$queryRaw<Array<{ starts_at: Date; ends_at: Date }>>`
          WITH bounds AS (
            SELECT
              (${input.date}::date + ${period.startTime}::time) AT TIME ZONE ${tenant.timezone} AS starts_at,
              (${input.date}::date + ${period.endTime}::time) AT TIME ZONE ${tenant.timezone} AS ends_at
          ), candidates AS (
            SELECT candidate AS starts_at
            FROM bounds,
              LATERAL generate_series(
                bounds.starts_at,
                bounds.ends_at - make_interval(mins => ${durationMinutes}::int),
                interval '15 minutes'
              ) AS candidate
          )
          SELECT
            candidates.starts_at,
            candidates.starts_at + make_interval(mins => ${durationMinutes}::int) AS ends_at
          FROM candidates
          WHERE NOT EXISTS (
            SELECT 1
            FROM bookings booking
            WHERE booking.tenant_id=${input.tenantId}::uuid
              AND booking.resource_id=${resourceId}::uuid
              AND booking.status IN ('pending', 'confirmed')
              AND tstzrange(booking.occupied_start_at, booking.occupied_end_at, '[)') &&
                tstzrange(
                  candidates.starts_at - make_interval(mins => ${service.bufferBeforeMinutes}::int),
                  candidates.starts_at + make_interval(mins => ${durationMinutes + service.bufferAfterMinutes}::int),
                  '[)'
                )
          )
          ORDER BY candidates.starts_at
          LIMIT 50
        `;
        slots.push(
          ...rows.map((row) => ({
            startsAt: row.starts_at.toISOString(),
            endsAt: row.ends_at.toISOString(),
          })),
        );
        if (slots.length >= 50) break;
      }

      return {
        timezone: tenant.timezone,
        resourceId,
        staffId: input.staffId ?? null,
        slots: slots.slice(0, 50),
      };
    });
  }

  private async ensureDefaultResourceInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO booking_resources (tenant_id, kind, name)
      VALUES (${tenantId}::uuid, 'default', 'Default resource')
      ON CONFLICT DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM booking_resources
      WHERE tenant_id=${tenantId}::uuid AND kind='default' AND active=true
      LIMIT 1
    `;
    const resource = rows[0];
    if (!resource) throw new Error('Default booking resource is unavailable');
    return resource.id;
  }

  private async ensureStaffResourceInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    staffId: string,
    name: string,
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO booking_resources (tenant_id, kind, staff_id, name)
      VALUES (${tenantId}::uuid, 'staff', ${staffId}::uuid, ${name})
      ON CONFLICT DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM booking_resources
      WHERE tenant_id=${tenantId}::uuid AND staff_id=${staffId}::uuid AND kind='staff' AND active=true
      LIMIT 1
    `;
    const resource = rows[0];
    if (!resource) throw new Error('Staff booking resource is unavailable');
    return resource.id;
  }
}
