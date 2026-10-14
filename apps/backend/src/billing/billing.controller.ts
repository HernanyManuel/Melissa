import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { BillingService } from './billing.service';
import { BillingUsageService } from './billing-usage.service';
import { BillingEntitlementService } from './billing-entitlement.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { CheckoutDto } from './checkout.dto';
import { StripePortalService } from './stripe-portal.service';

@ApiTags('Billing (test Checkout foundation)')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly usage: BillingUsageService,
    private readonly entitlements: BillingEntitlementService,
    private readonly checkout: StripeCheckoutService,
    private readonly portal: StripePortalService,
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

  @Post('portal')
  @ApiOperation({
    summary: 'Launch a strictly read-only Stripe TEST customer billing Portal',
    description:
      'Opt-in test environment and owner/admin only. Requires a previously bound Stripe Checkout and a current matching test subscription. No billing mutation or entitlement activation.',
  })
  launchPortal(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.portal.launch(req.actor, tenantId);
  }

  @Get('usage')
  @ApiOperation({
    summary: 'Read 30-day technical AI token observations without calculating charges',
    description:
      'Owner/admin only. Source is the immutable AI usage journal. Counts are not billable conversations, monetary amounts, or entitlements.',
  })
  usageReport(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.usage.report(req.actor, tenantId);
  }

  @Get('entitlements')
  @ApiOperation({
    summary: 'Preview tenant quota counts and deny-only commercial entitlement policy',
    description:
      'Owner/admin read-only diagnostic. Counts active staff/channels, marks undefined billable metrics, and NEVER authorizes paid automation, regardless of Stripe status.',
  })
  entitlementAssessment(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ) {
    return this.entitlements.assess(req.actor, tenantId);
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
