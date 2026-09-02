import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, TenantRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Dependencies } from '../dependencies';
import { Actor } from '../identity/auth.service';
import { IdentityMail } from '../identity/mail';
import { opaqueToken, tokenHash } from '../identity/password';
import { TenantDto, MemberDto, InviteDto } from './dto';
import { allows, Permission } from './permissions';

@Injectable()
export class TenantService {
  constructor(
    private readonly deps: Dependencies,
    private readonly mail: IdentityMail,
  ) {}
  private async actor(tx: Prisma.TransactionClient, actor: Actor): Promise<void> {
    const session = await tx.session.findUnique({ where: { id: actor.sessionId } });
    if (
      !session ||
      session.userId !== actor.userId ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    )
      throw new ForbiddenException();
    await tx.$executeRaw`SELECT set_config('app.actor_id', ${actor.userId}, true)`;
  }
  async scoped<T>(
    actor: Actor,
    id: string,
    permission: Permission,
    run: (tx: Prisma.TransactionClient, role: TenantRole) => Promise<T>,
  ): Promise<T> {
    return this.deps.db.$transaction(async (tx) => {
      await this.actor(tx, actor);
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: id, userId: actor.userId } },
      });
      if (!member?.active) throw new NotFoundException();
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
      // Tenant lock serializes membership changes, preventing stale-role writes.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.membership.findUniqueOrThrow({ where: { id: member.id } });
      if (!current.active || !allows(current.role, permission)) throw new ForbiddenException();
      return run(tx, current.role);
    });
  }
  audit(
    tx: Prisma.TransactionClient,
    actor: Actor,
    tenantId: string,
    action: string,
    targetId: string,
  ) {
    return tx.auditEvent.create({ data: { tenantId, actorId: actor.userId, action, targetId } });
  }
  list(actor: Actor) {
    return this.deps.db.$transaction(async (tx) => {
      await this.actor(tx, actor);
      return tx.membership.findMany({
        where: { userId: actor.userId, active: true },
        select: { role: true, tenant: true },
        orderBy: { tenantId: 'asc' },
        take: 100,
      });
    });
  }
  private validate(input: TenantDto): void {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
    } catch {
      throw new BadRequestException();
    }
  }
  create(actor: Actor, input: TenantDto) {
    this.validate(input);
    return this.deps.db.$transaction(async (tx) => {
      await this.actor(tx, actor);
      const id = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
      const tenant = await tx.tenant.create({
        data: {
          id,
          name: input.name.trim(),
          countryCode: input.countryCode,
          timezone: input.timezone,
        },
      });
      await tx.membership.create({ data: { tenantId: id, userId: actor.userId, role: 'owner' } });
      await this.audit(tx, actor, id, 'tenant.created', id);
      return tenant;
    });
  }
  get(actor: Actor, id: string) {
    return this.scoped(actor, id, 'tenant:read', (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id } }),
    );
  }
  update(actor: Actor, id: string, input: TenantDto) {
    this.validate(input);
    return this.scoped(actor, id, 'tenant:write', async (tx) => {
      const tenant = await tx.tenant.update({
        where: { id },
        data: { name: input.name.trim(), countryCode: input.countryCode, timezone: input.timezone },
      });
      await this.audit(tx, actor, id, 'tenant.updated', id);
      return tenant;
    });
  }
  members(actor: Actor, id: string) {
    return this.scoped(actor, id, 'members:read', (tx) =>
      tx.membership.findMany({
        where: { tenantId: id },
        select: {
          id: true,
          userId: true,
          role: true,
          active: true,
          user: { select: { name: true, email: true } },
        },
        take: 100,
      }),
    );
  }
  changeMember(actor: Actor, id: string, memberId: string, input: MemberDto) {
    return this.scoped(actor, id, 'members:write', async (tx, role) => {
      const target = await tx.membership.findFirst({ where: { tenantId: id, id: memberId } });
      if (!target) throw new NotFoundException();
      // Ownership transfer requires separate reauthentication flow. Never demote or add owners here.
      if (
        target.role === 'owner' ||
        input.role === 'owner' ||
        (role === 'admin' && (target.role === 'admin' || input.role === 'admin'))
      )
        throw new ForbiddenException();
      const result = await tx.membership.update({
        where: { tenantId_id: { tenantId: id, id: memberId } },
        data: { role: input.role, active: input.active },
      });
      await this.audit(tx, actor, id, 'membership.updated', memberId);
      return result;
    });
  }
  async invite(actor: Actor, id: string, input: InviteDto) {
    const token = opaqueToken();
    const email = input.email.toLowerCase().trim();
    const invite = await this.scoped(actor, id, 'members:write', async (tx, role) => {
      if (input.role === 'owner' || (role === 'admin' && input.role === 'admin'))
        throw new ForbiddenException();
      const invitation = await tx.invitation.create({
        data: {
          tenantId: id,
          email,
          role: input.role,
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      await this.audit(tx, actor, id, 'invitation.created', invitation.id);
      return invitation;
    });
    await this.mail.send(email, 'invite', token, id);
    return { id: invite.id, expiresAt: invite.expiresAt };
  }
  accept(actor: Actor, id: string, token: string) {
    return this.deps.db.$transaction(async (tx) => {
      await this.actor(tx, actor);
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
      await tx.$executeRaw`SELECT set_config('app.invite_hash',${tokenHash(token)},true)`;
      const invite = await tx.invitation.findFirst({
        where: {
          tenantId: id,
          tokenHash: tokenHash(token),
          email: user.email,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!invite || !user.verifiedAt) throw new NotFoundException();
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${id},true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${id}::uuid FOR UPDATE`;
      const claimed = await tx.invitation.updateMany({
        where: { id: invite.id, tenantId: id, acceptedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new BadRequestException();
      const existing = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: id, userId: actor.userId } },
      });
      if (existing) throw new BadRequestException(); // invitations cannot overwrite/reinstate a membership
      const member = await tx.membership.create({
        data: { tenantId: id, userId: actor.userId, role: invite.role },
      });
      await this.audit(tx, actor, id, 'invitation.accepted', member.id);
      return member;
    });
  }
  auditEvents(actor: Actor, id: string) {
    return this.scoped(actor, id, 'audit:read', (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }
}
