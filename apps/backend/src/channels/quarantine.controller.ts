import {
  Controller,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { MessagePageDto } from '../messaging/dto';

@Injectable()
export class QuarantineService {
  constructor(private readonly tenants: TenantService) {}

  list(actor: Actor, tenantId: string, page: MessagePageDto) {
    return this.tenants.scoped(actor, tenantId, 'channels:manage', async (tx) => {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 86400000);
      const [rows, total, expired, expiringSoon] = await Promise.all([
        tx.whatsAppQuarantine.findMany({
          where: { tenantId, ...(page.after ? { id: { gt: page.after } } : {}) },
          orderBy: { id: 'asc' },
          take: 51,
          // Deliberate allowlist: never fetch ciphertext, nonce, tag or key ID for this API.
          select: { id: true, channelId: true, createdAt: true, expiresAt: true },
        }),
        tx.whatsAppQuarantine.count({ where: { tenantId } }),
        tx.whatsAppQuarantine.count({ where: { tenantId, expiresAt: { lte: now } } }),
        tx.whatsAppQuarantine.count({ where: { tenantId, expiresAt: { gt: now, lte: tomorrow } } }),
      ]);
      const channels = await tx.channelConnection.findMany({
        where: {
          tenantId,
          id: { in: rows.slice(0, 50).map((row) => row.channelId) },
        },
        select: { id: true, displayName: true },
      });
      return {
        items: rows.slice(0, 50).map((row) => ({
          ...row,
          channelName: channels.find((channel) => channel.id === row.channelId)?.displayName ?? '',
          expired: row.expiresAt <= now,
        })),
        next: rows.length > 50 ? rows[49]!.id : null,
        total,
        expired,
        expiringSoon,
        capacity: 1000,
        asOf: now,
      };
    });
  }
}

@ApiTags('Quarantine operations')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/quarantine')
export class QuarantineController {
  constructor(private readonly quarantine: QuarantineService) {}
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() page: MessagePageDto,
  ) {
    return this.quarantine.list(req.actor, tenant, page);
  }
}
