import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { BillingService } from './billing.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { CheckoutDto } from './checkout.dto';

@ApiTags('Billing (test Checkout foundation)')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly checkout: StripeCheckoutService,
  ) {}

  @Get('plans')
  @ApiOperation({
    summary: 'Read the configured active commercial plan catalog',
    description:
      'Owner/admin only; empty until a privileged operator publishes plans. No Stripe identifiers or hardcoded prices.',
  })
  plans(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.billing.plans(req.actor, tenantId);
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Create an idempotent Stripe TEST hosted Checkout session',
    description:
      'Owner/admin only; opt-in test mode. A checkout URL is not payment verification, subscription association or an entitlement.',
  })
  createCheckout(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: CheckoutDto,
  ) {
    return this.checkout.create(req.actor, tenantId, body);
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
