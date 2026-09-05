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
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { MessagePageDto } from '../messaging/dto';
import { QUARANTINE_CAPACITY, quarantineNotices } from './quarantine-policy';
import { QuarantinePageResponseDto, QuarantineErrorResponseDto } from './quarantine.dto';

@Injectable()
export class QuarantineService {
  constructor(private readonly tenants: TenantService) {}

  list(actor: Actor, tenantId: string, page: MessagePageDto): Promise<QuarantinePageResponseDto> {
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
        capacity: QUARANTINE_CAPACITY,
        notices: quarantineNotices(total, expired, expiringSoon),
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
  @ApiOperation({
    operationId: 'listQuarantineMetadata',
    summary: 'List tenant quarantine metadata',
    description:
      'Owner/admin only. Tenant selector is verified against the session and membership. No payload, ciphertext, key, hash or recipient data is returned. Read-only; no review or reprocessing.',
  })
  @ApiParam({ name: 'tenantId', format: 'uuid', required: true })
  @ApiQuery({
    name: 'after',
    required: false,
    type: String,
    format: 'uuid',
    description: 'Exclusive ID cursor. Omit for the first page; fixed page size of 50.',
  })
  @ApiOkResponse({
    type: QuarantinePageResponseDto,
    headers: {
      'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
      'X-Request-Id': { schema: { type: 'string', format: 'uuid' } },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR: invalid UUID or unsupported query parameter.',
    type: QuarantineErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'UNAUTHORIZED: missing, invalid or revoked session.',
    type: QuarantineErrorResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'FORBIDDEN: membership lacks channels:manage.',
    type: QuarantineErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'NOT_FOUND: tenant absent or inaccessible to this actor.',
    type: QuarantineErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: 'INTERNAL_ERROR: sanitized failure; no database details.',
    type: QuarantineErrorResponseDto,
  })
  list(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() page: MessagePageDto,
  ) {
    return this.quarantine.list(req.actor, tenant, page);
  }
}
