import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import {
  evaluateCommercialEntitlements,
  observedQuota,
  undefinedBillableQuota,
  unmodeledLocationQuota,
} from './entitlement-policy';

// Read-only operator-facing preview: never used to authorize AI outbound,
// invoice collection or creating billable resources. All reads are tenant
// scoped in a single PostgreSQL transaction with normal membership checks.
@Injectable()
export class BillingEntitlementService {
  constructor(private readonly tenants: TenantService) {}

  assess(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'billing:read', async (tx) => {
      const [gate] = await tx.$queryRaw<Array<{
        enabled: boolean;
        policyVersion: number;
      }>>`
        SELECT enabled, policy_version AS "policyVersion"
        FROM billing_entitlement_activation_gate WHERE key='paid_automation'`;
      // Missing/malformed gate indicates a migration or RLS failure;
      // do not manufacture an apparently healthy billing assessment.
      if (!gate || gate.enabled !== false || gate.policyVersion !== 1)
        throw new ServiceUnavailableException('Billing policy unavailable');

      const subscription = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          provider: true,
          status: true,
          planId: true,
          checkoutSessionId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          plan: {
            select: {
              active: true,
              stripePriceId: true,
              includedStaff: true,
              includedChannels: true,
            },
          },
        },
      });

      const [usedStaff, usedChannels] = await Promise.all([
        tx.staff.count({ where: { tenantId, active: true } }),
        tx.channelConnection.count({
          where: { tenantId, status: 'active', disconnectedAt: null },
        }),
      ]);

      let localCheckoutMatched = false;
      if (subscription?.checkoutSessionId?.startsWith('cs_test_')) {
        const intent = await tx.stripeCheckoutIntent.findUnique({
          where: { checkoutSessionId: subscription.checkoutSessionId },
          select: { tenantId: true, planId: true, stripePriceId: true, status: true },
        });
        localCheckoutMatched =
          intent?.tenantId === tenantId &&
          intent.planId === subscription.planId &&
          intent.stripePriceId === subscription.plan.stripePriceId &&
          intent.status === 'ready';
      }

      const now = new Date();
      const decision = evaluateCommercialEntitlements({
        gateEnabled: gate.enabled,
        subscriptionPresent: subscription !== null,
        provider: subscription?.provider ?? null,
        status: subscription?.status ?? null,
        periodStart: subscription?.currentPeriodStart ?? null,
        periodEnd: subscription?.currentPeriodEnd ?? null,
        activePlan: subscription?.plan.active === true,
        localCheckoutMatched,
        billingVerificationPresent: false,
        billableUsageDefined: false,
      }, now);

      const validPlan = subscription?.plan.active === true ? subscription.plan : null;
      return {
        decision,
        asOf: now,
        quotaPreview: {
          staff: observedQuota(usedStaff, validPlan?.includedStaff ?? null),
          channels: observedQuota(usedChannels, validPlan?.includedChannels ?? null),
          locations: unmodeledLocationQuota,
          conversations: undefinedBillableQuota,
          messages: undefinedBillableQuota,
        },
      };
    });
  }
}
