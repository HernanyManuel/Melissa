import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { BookingPolicyDto, ResourceBlockDto } from './dto';

interface BookingPolicyView {
  cancellationEnabled: boolean;
  cancellationMinNoticeMinutes: number;
  reschedulingEnabled: boolean;
  reschedulingMinNoticeMinutes: number;
  creationMinNoticeMinutes: number;
  creationMaxHorizonDays: number | null;
  version: number;
}

interface ResourceBlockView {
  id: string;
  staffId: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class BookingAdminService {
  constructor(private readonly tenants: TenantService) {}

  getPolicy(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', async (tx) => {
      const [policy] = await tx.$queryRaw<BookingPolicyView[]>`
        SELECT
          COALESCE(policy.cancellation_enabled, true) AS "cancellationEnabled",
          COALESCE(policy.cancellation_min_notice_minutes, 0) AS "cancellationMinNoticeMinutes",
          COALESCE(policy.rescheduling_enabled, true) AS "reschedulingEnabled",
          COALESCE(policy.rescheduling_min_notice_minutes, 0) AS "reschedulingMinNoticeMinutes",
          COALESCE(policy.creation_min_notice_minutes, 0) AS "creationMinNoticeMinutes",
          policy.creation_max_horizon_days AS "creationMaxHorizonDays",
          COALESCE(policy.version, 1) AS version
        FROM tenants tenant
        LEFT JOIN booking_policies policy ON policy.tenant_id=tenant.id
        WHERE tenant.id=${tenantId}::uuid
      `;
      if (!policy) throw new NotFoundException();
      return policy;
    });
  }

  savePolicy(actor: Actor, tenantId: string, input: BookingPolicyDto) {
    if (
      input.creationMaxHorizonDays !== undefined &&
      input.creationMaxHorizonDays !== null &&
      input.creationMinNoticeMinutes > input.creationMaxHorizonDays * 1440
    )
      throw new BadRequestException();

    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const [policy] = await tx.$queryRaw<BookingPolicyView[]>`
        INSERT INTO booking_policies (
          tenant_id,
          cancellation_enabled,
          cancellation_min_notice_minutes,
          rescheduling_enabled,
          rescheduling_min_notice_minutes,
          creation_min_notice_minutes,
          creation_max_horizon_days
        ) VALUES (
          ${tenantId}::uuid,
          ${input.cancellationEnabled},
          ${input.cancellationMinNoticeMinutes},
          ${input.reschedulingEnabled},
          ${input.reschedulingMinNoticeMinutes},
          ${input.creationMinNoticeMinutes},
          ${input.creationMaxHorizonDays ?? null}::int
        )
        ON CONFLICT (tenant_id) DO UPDATE SET
          cancellation_enabled=EXCLUDED.cancellation_enabled,
          cancellation_min_notice_minutes=EXCLUDED.cancellation_min_notice_minutes,
          rescheduling_enabled=EXCLUDED.rescheduling_enabled,
          rescheduling_min_notice_minutes=EXCLUDED.rescheduling_min_notice_minutes,
          creation_min_notice_minutes=EXCLUDED.creation_min_notice_minutes,
          creation_max_horizon_days=EXCLUDED.creation_max_horizon_days,
          version=booking_policies.version+1,
          updated_at=CURRENT_TIMESTAMP
        RETURNING
          cancellation_enabled AS "cancellationEnabled",
          cancellation_min_notice_minutes AS "cancellationMinNoticeMinutes",
          rescheduling_enabled AS "reschedulingEnabled",
          rescheduling_min_notice_minutes AS "reschedulingMinNoticeMinutes",
          creation_min_notice_minutes AS "creationMinNoticeMinutes",
          creation_max_horizon_days AS "creationMaxHorizonDays",
          version
      `;
      if (!policy) throw new Error('Booking policy update failed');
      await this.tenants.audit(tx, actor, tenantId, 'booking_policy.updated', tenantId);
      return policy;
    });
  }

  listBlocks(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:read', (tx) =>
      tx.$queryRaw<ResourceBlockView[]>`
        SELECT
          block.id::text AS id,
          resource.staff_id::text AS "staffId",
          block.starts_at AS "startsAt",
          block.ends_at AS "endsAt",
          block.reason,
          block.created_at AS "createdAt",
          block.updated_at AS "updatedAt"
        FROM resource_blocks block
        JOIN booking_resources resource
          ON resource.tenant_id=block.tenant_id AND resource.id=block.resource_id
        WHERE block.tenant_id=${tenantId}::uuid
        ORDER BY block.starts_at, block.id
        LIMIT 500
      `,
    );
  }

  createBlock(actor: Actor, tenantId: string, input: ResourceBlockDto) {
    const interval = this.interval(input);
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const resourceId = await this.resolveResource(tx, tenantId, input.staffId);
      await this.lockResources(tx, tenantId, resourceId, resourceId);
      await this.rejectBookingOverlap(tx, tenantId, resourceId, interval.startsAt, interval.endsAt);
      const [block] = await tx.$queryRaw<ResourceBlockView[]>`
        INSERT INTO resource_blocks (tenant_id, resource_id, starts_at, ends_at, reason)
        VALUES (
          ${tenantId}::uuid,
          ${resourceId}::uuid,
          ${interval.startsAt},
          ${interval.endsAt},
          ${input.reason ?? null}
        )
        RETURNING
          id::text AS id,
          ${input.staffId ?? null}::uuid::text AS "staffId",
          starts_at AS "startsAt",
          ends_at AS "endsAt",
          reason,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      if (!block) throw new Error('Resource block creation failed');
      await this.tenants.audit(tx, actor, tenantId, 'resource_block.created', block.id);
      return block;
    });
  }

  updateBlock(actor: Actor, tenantId: string, blockId: string, input: ResourceBlockDto) {
    const interval = this.interval(input);
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const [current] = await tx.$queryRaw<Array<{ resourceId: string }>>`
        SELECT resource_id::text AS "resourceId"
        FROM resource_blocks
        WHERE tenant_id=${tenantId}::uuid AND id=${blockId}::uuid
      `;
      if (!current) throw new NotFoundException();

      const resourceId = await this.resolveResource(tx, tenantId, input.staffId);
      await this.lockResources(tx, tenantId, current.resourceId, resourceId);
      await this.rejectBookingOverlap(tx, tenantId, resourceId, interval.startsAt, interval.endsAt);
      const [block] = await tx.$queryRaw<ResourceBlockView[]>`
        UPDATE resource_blocks
        SET resource_id=${resourceId}::uuid,
          starts_at=${interval.startsAt},
          ends_at=${interval.endsAt},
          reason=${input.reason ?? null},
          updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=${tenantId}::uuid AND id=${blockId}::uuid
        RETURNING
          id::text AS id,
          ${input.staffId ?? null}::uuid::text AS "staffId",
          starts_at AS "startsAt",
          ends_at AS "endsAt",
          reason,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      if (!block) throw new NotFoundException();
      await this.tenants.audit(tx, actor, tenantId, 'resource_block.updated', block.id);
      return block;
    });
  }

  deleteBlock(actor: Actor, tenantId: string, blockId: string) {
    return this.tenants.scoped(actor, tenantId, 'business:write', async (tx) => {
      const deleted = await tx.$queryRaw<Array<{ id: string }>>`
        DELETE FROM resource_blocks
        WHERE tenant_id=${tenantId}::uuid AND id=${blockId}::uuid
        RETURNING id::text
      `;
      if (!deleted.length) throw new NotFoundException();
      await this.tenants.audit(tx, actor, tenantId, 'resource_block.deleted', blockId);
    });
  }

  private interval(input: ResourceBlockDto): { startsAt: Date; endsAt: Date } {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.valueOf()) || Number.isNaN(endsAt.valueOf()) || endsAt <= startsAt)
      throw new BadRequestException();
    return { startsAt, endsAt };
  }

  private async resolveResource(
    tx: Prisma.TransactionClient,
    tenantId: string,
    staffId?: string,
  ): Promise<string> {
    if (staffId) {
      const staff = await tx.staff.findFirst({
        where: { tenantId, id: staffId, active: true },
        select: { name: true },
      });
      if (!staff) throw new BadRequestException();
      await tx.$executeRaw`
        INSERT INTO booking_resources (tenant_id, kind, staff_id, name)
        VALUES (${tenantId}::uuid, 'staff', ${staffId}::uuid, ${staff.name})
        ON CONFLICT DO NOTHING
      `;
      const [resource] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text
        FROM booking_resources
        WHERE tenant_id=${tenantId}::uuid AND kind='staff'
          AND staff_id=${staffId}::uuid AND active=true
      `;
      if (!resource) throw new BadRequestException();
      return resource.id;
    }

    await tx.$executeRaw`
      INSERT INTO booking_resources (tenant_id, kind, name)
      VALUES (${tenantId}::uuid, 'default', 'Default resource')
      ON CONFLICT DO NOTHING
    `;
    const [resource] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM booking_resources
      WHERE tenant_id=${tenantId}::uuid AND kind='default' AND active=true
    `;
    if (!resource) throw new BadRequestException();
    return resource.id;
  }

  private async lockResources(
    tx: Prisma.TransactionClient,
    tenantId: string,
    firstId: string,
    secondId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text
      FROM booking_resources
      WHERE tenant_id=${tenantId}::uuid
        AND (id=${firstId}::uuid OR id=${secondId}::uuid)
      ORDER BY id
      FOR UPDATE
    `;
    if (!rows.length) throw new BadRequestException();
  }

  private async rejectBookingOverlap(
    tx: Prisma.TransactionClient,
    tenantId: string,
    resourceId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM bookings booking
        WHERE booking.tenant_id=${tenantId}::uuid
          AND booking.resource_id=${resourceId}::uuid
          AND booking.status IN ('pending', 'confirmed')
          AND tstzrange(booking.occupied_start_at, booking.occupied_end_at, '[)') &&
            tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
      ) AS exists
    `;
    if (rows[0]?.exists) throw new BadRequestException();
  }
}
