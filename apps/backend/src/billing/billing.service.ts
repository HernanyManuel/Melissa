import { Injectable } from '@nestjs/common';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';

const publicPlan = {
  id: true,
  key: true,
  name: true,
  currency: true,
  basePrice: true,
  billingInterval: true,
  includedConversations: true,
  includedMessages: true,
  includedStaff: true,
  includedChannels: true,
  includedLocations: true,
  overagePricePerConversation: true,
  features: true,
} as const;

@Injectable()
export class BillingService {
  constructor(private readonly tenants: TenantService) {}

  // Read-only and owner/admin-gated. A public plan is not an entitlement,
  // and prices are read from the catalog rather than hardcoded examples.
  plans(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'billing:read', async (tx) => ({
      items: await tx.billingPlan.findMany({
        where: { active: true },
        select: publicPlan,
        orderBy: [{ key: 'asc' }],
        take: 100,
      }),
    }));
  }

  subscription(actor: Actor, tenantId: string) {
    return this.tenants.scoped(actor, tenantId, 'billing:read', async (tx) => {
      const row = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          id: true,
          provider: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          trialEnd: true,
          plan: { select: publicPlan },
        },
      });
      // Until signed Stripe webhooks, reconciliation and backend quota
      // enforcement exist, no status shown here ever authorizes paid work.
      return {
        subscription: row,
        entitlements: {
          automationEnabled: false,
          billingVerified: false,
          reason: 'billing_not_enabled',
        },
      };
    });
  }
}
