import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { AnalyticsService } from './analytics.service';

@ApiTags('Technical analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Read rolling 30-day tenant-scoped technical conversation and AI turn counts',
    description:
      'Owner/admin only. No billing, financial settlement, entitlement or commercial attribution.',
  })
  summary(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.analytics.summary(req.actor, tenantId);
  }
}
