import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { BookingAdminService } from '../src/business/booking-admin.service';
import { parseConfig } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { IdentityMail } from '../src/identity/mail';
import { TenantService } from '../src/tenancy/tenant.service';

test(
  'booking administration is tenant-scoped, audited and serializes blocks against bookings',
  { timeout: 15000 },
  async () => {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL;
    assert(migrationUrl, 'booking admin integration requires MIGRATION_DATABASE_URL');
    const deps = new Dependencies(parseConfig(process.env));
    const admin = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
    const tenants = new TenantService(deps, {} as IdentityMail);
    const service = new BookingAdminService(tenants);
    const tenantId = randomUUID();
    const foreignTenantId = randomUUID();
    const ownerId = randomUUID();
    const ownerSessionId = randomUUID();
    const viewerId = randomUUID();
    const viewerSessionId = randomUUID();
    const staffId = randomUUID();
    const customerId = randomUUID();
    const serviceId = randomUUID();
    const owner = { userId: ownerId, sessionId: ownerSessionId };
    const viewer = { userId: viewerId, sessionId: viewerSessionId };

    try {
      await admin.tenant.createMany({
        data: [
          { id: tenantId, name: 'Booking admin tenant', countryCode: 'PT', timezone: 'UTC' },
          {
            id: foreignTenantId,
            name: 'Foreign booking admin tenant',
            countryCode: 'PT',
            timezone: 'UTC',
          },
        ],
      });
      await admin.user.createMany({
        data: [
          {
            id: ownerId,
            email: `${ownerId}@example.test`,
            passwordHash: 'integration-only',
            name: 'Owner',
            termsVersion: 'test',
            termsAcceptedAt: new Date(),
            verifiedAt: new Date(),
          },
          {
            id: viewerId,
            email: `${viewerId}@example.test`,
            passwordHash: 'integration-only',
            name: 'Viewer',
            termsVersion: 'test',
            termsAcceptedAt: new Date(),
            verifiedAt: new Date(),
          },
        ],
      });
      await admin.session.createMany({
        data: [
          { id: ownerSessionId, userId: ownerId, expiresAt: new Date(Date.now() + 3600000) },
          { id: viewerSessionId, userId: viewerId, expiresAt: new Date(Date.now() + 3600000) },
        ],
      });
      await admin.membership.createMany({
        data: [
          { tenantId, userId: ownerId, role: 'owner', active: true },
          { tenantId, userId: viewerId, role: 'viewer', active: true },
        ],
      });
      await admin.staff.create({
        data: { id: staffId, tenantId, name: 'Blocked staff', active: true, timezone: 'UTC' },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          tenantId,
          displayName: 'Booking admin customer',
          phoneE164: '+351910000098',
        },
      });
      await admin.businessService.create({
        data: {
          id: serviceId,
          tenantId,
          name: 'Booking admin service',
          slug: `booking-admin-${serviceId}`,
          price: '20.00',
          currency: 'EUR',
          durationMinutes: 30,
          bookingEnabled: true,
          active: true,
        },
      });

      assert.deepEqual(await service.getPolicy(owner, tenantId), {
        cancellationEnabled: true,
        cancellationMinNoticeMinutes: 0,
        reschedulingEnabled: true,
        reschedulingMinNoticeMinutes: 0,
        creationMinNoticeMinutes: 0,
        creationMaxHorizonDays: null,
        version: 1,
      });
      const savedPolicy = await service.savePolicy(owner, tenantId, {
        expectedVersion: 1,
        cancellationEnabled: false,
        cancellationMinNoticeMinutes: 60,
        reschedulingEnabled: true,
        reschedulingMinNoticeMinutes: 120,
        creationMinNoticeMinutes: 180,
        creationMaxHorizonDays: 30,
      });
      assert.equal(savedPolicy.cancellationEnabled, false);
      assert.equal(savedPolicy.creationMinNoticeMinutes, 180);
      assert.equal(savedPolicy.creationMaxHorizonDays, 30);
      assert.equal(savedPolicy.version, 2);

      await assert.rejects(
        service.savePolicy(owner, tenantId, {
          expectedVersion: 1,
          cancellationEnabled: true,
          cancellationMinNoticeMinutes: 0,
          reschedulingEnabled: false,
          reschedulingMinNoticeMinutes: 0,
          creationMinNoticeMinutes: 0,
          creationMaxHorizonDays: null,
        }),
        (error) => error instanceof ConflictException,
      );
      assert.deepEqual(await service.getPolicy(owner, tenantId), savedPolicy);

      await assert.rejects(
        service.savePolicy(viewer, tenantId, {
          expectedVersion: 2,
          cancellationEnabled: true,
          cancellationMinNoticeMinutes: 0,
          reschedulingEnabled: true,
          reschedulingMinNoticeMinutes: 0,
          creationMinNoticeMinutes: 0,
          creationMaxHorizonDays: null,
        }),
        (error) => error instanceof ForbiddenException,
      );
      await assert.rejects(
        service.getPolicy(owner, foreignTenantId),
        (error) => error instanceof NotFoundException,
      );
      await assert.rejects(
        service.savePolicy(owner, tenantId, {
          expectedVersion: 2,
          cancellationEnabled: true,
          cancellationMinNoticeMinutes: 0,
          reschedulingEnabled: true,
          reschedulingMinNoticeMinutes: 0,
          creationMinNoticeMinutes: 2881,
          creationMaxHorizonDays: 2,
        }),
        (error) => error instanceof BadRequestException,
      );

      const defaultBlock = await service.createBlock(owner, tenantId, {
        startsAt: '2030-01-01T10:00:00.000Z',
        endsAt: '2030-01-01T11:00:00.000Z',
        reason: 'Default resource maintenance',
      });
      assert.equal(defaultBlock.staffId, null);
      const staffBlock = await service.createBlock(owner, tenantId, {
        staffId,
        startsAt: '2030-01-02T10:00:00.000Z',
        endsAt: '2030-01-02T11:00:00.000Z',
        reason: 'Staff unavailable',
      });
      assert.equal(staffBlock.staffId, staffId);

      const listed = await service.listBlocks(owner, tenantId);
      assert.deepEqual(
        listed.map((block) => block.id),
        [defaultBlock.id, staffBlock.id],
      );

      const [defaultResource] = await admin.$queryRaw<Array<{ id: string }>>`
        SELECT id::text
        FROM booking_resources
        WHERE tenant_id=${tenantId}::uuid AND kind='default'
      `;
      assert(defaultResource);
      await admin.$executeRaw`
        INSERT INTO bookings (
          tenant_id, customer_id, service_id, resource_id, source, status,
          starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
        ) VALUES (
          ${tenantId}::uuid,
          ${customerId}::uuid,
          ${serviceId}::uuid,
          ${defaultResource.id}::uuid,
          'manual',
          'confirmed',
          '2030-01-03T10:00:00.000Z'::timestamptz,
          '2030-01-03T10:30:00.000Z'::timestamptz,
          15,
          15
        )
      `;
      await assert.rejects(
        service.createBlock(owner, tenantId, {
          startsAt: '2030-01-03T09:50:00.000Z',
          endsAt: '2030-01-03T10:05:00.000Z',
          reason: 'Must conflict with booking buffer',
        }),
        (error) => error instanceof BadRequestException,
      );

      const moved = await service.updateBlock(owner, tenantId, staffBlock.id, {
        startsAt: '2030-01-04T10:00:00.000Z',
        endsAt: '2030-01-04T11:00:00.000Z',
        reason: 'Moved to default resource',
      });
      assert.equal(moved.staffId, null);
      await service.deleteBlock(owner, tenantId, defaultBlock.id);
      assert.deepEqual(
        (await service.listBlocks(owner, tenantId)).map((block) => block.id),
        [staffBlock.id],
      );

      const audit = await admin.auditEvent.findMany({
        where: {
          tenantId,
          action: {
            in: [
              'booking_policy.updated',
              'resource_block.created',
              'resource_block.updated',
              'resource_block.deleted',
            ],
          },
        },
        select: { action: true },
      });
      assert.equal(audit.filter((event) => event.action === 'booking_policy.updated').length, 1);
      assert.equal(audit.filter((event) => event.action === 'resource_block.created').length, 2);
      assert.equal(audit.filter((event) => event.action === 'resource_block.updated').length, 1);
      assert.equal(audit.filter((event) => event.action === 'resource_block.deleted').length, 1);
    } finally {
      await deps.onModuleDestroy();
      await admin.$disconnect();
    }
  },
);
