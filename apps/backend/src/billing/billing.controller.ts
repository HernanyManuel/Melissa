import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { BillingService } from './billing.service';

@ApiTags('Billing (read-only foundation)')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @ApiOperation({
    summary: 'Read the configured active commercial plan catalog',
    description:
      'Owner/admin only; empty until a privileged operator publishes plans. No Stripe identifiers or hardcoded prices.',
  })
  plans(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.billing.plans(req.actor, tenantId);
  }

  @Get('subscription')
  @ApiOperation({
    summary: 'Read the tenant billing snapshot without activating paid entitlements',
    description:
      'Owner/admin only. The subscription is a read-only provider snapshot; entitlements remain disabled pending Stripe verification, reconciliation and quota enforcement.',
  })
  subscription(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.billing.subscription(req.actor, tenantId);
  }
}
