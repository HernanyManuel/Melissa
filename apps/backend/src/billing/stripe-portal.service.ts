import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { CONFIG, Configuration } from '../config';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { StripePortalGateway } from './stripe-test-portal-provider';

@Injectable()
export class StripePortalService {
  constructor(
    private readonly tenants: TenantService,
    private readonly gateway: StripePortalGateway,
    @Inject(CONFIG) private readonly config: Configuration,
  ) {}

  async launch(actor: Actor, tenantId: string): Promise<{ portalUrl: string }> {
    if (this.config.NODE_ENV !== 'test' ||
        this.config.STRIPE_TEST_PORTAL_ENABLED !== 'true')
      throw new NotFoundException();

    const prepared = await this.tenants.scoped(actor, tenantId, 'billing:write', async (tx) => {
      // A durable audit provides a per-tenant 30s launch throttle. Fail
      // closed without storing bearer redirect tokens in PostgreSQL.
      const recent = await tx.auditEvent.findFirst({
        where: {
          tenantId, action: 'billing.portal.created',
          createdAt: { gt: new Date(Date.now() - 30000) },
        },
        select: { id: true },
      });
      if (recent) throw new HttpException('Portal recently launched', 429);
      const row = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          id: true, tenantId: true, provider: true, providerCustomerId: true,
          providerSubscriptionId: true, checkoutSessionId: true,
          planId: true, status: true, plan: {
            select: { stripePriceId: true, active: true },
          },
        },
      });
      if (
        !row || row.provider !== 'stripe' ||
        !row.checkoutSessionId?.startsWith('cs_test_') ||
        !row.plan.active || !row.plan.stripePriceId ||
        row.status !== 'active'
      )
        throw new ConflictException('Verified test subscription required');
      const intent = await tx.stripeCheckoutIntent.findUnique({
        where: { checkoutSessionId: row.checkoutSessionId },
        select: { tenantId: true, planId: true, status: true },
      });
      if (!intent || intent.tenantId !== tenantId ||
          intent.planId !== row.planId || intent.status !== 'ready')
        throw new ConflictException('Trusted test Checkout association required');
      return {
        localId: row.id,
        planId: row.planId,
        checkoutSessionId: row.checkoutSessionId,
        customerId: row.providerCustomerId,
        subscriptionId: row.providerSubscriptionId,
        priceId: row.plan.stripePriceId,
        configurationId: this.config.STRIPE_TEST_PORTAL_CONFIGURATION_ID!,
        origin: this.config.STRIPE_TEST_CHECKOUT_RETURN_ORIGIN!,
        tenantId,
      };
    });

    let session;
    try {
      // Fresh provider verification and read-only configuration are mandatory.
      // Network I/O happens outside the tenant lock/transaction.
      session = await this.gateway.open(prepared);
    } catch {
      throw new ServiceUnavailableException('Stripe test Portal unavailable');
    }

    // A revoked session, role change or replacement subscription cannot
    // receive a freshly minted bearer URL while Stripe is responding.
    await this.tenants.scoped(actor, tenantId, 'billing:write', async (tx) => {
      const row = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          id: true, provider: true, status: true,
          providerCustomerId: true, providerSubscriptionId: true,
          checkoutSessionId: true, plan: { select: { stripePriceId: true, active: true } },
        },
      });
      if (
        !row || row.id !== prepared.localId ||
        row.provider !== 'stripe' ||
        !row.checkoutSessionId?.startsWith('cs_test_') ||
        row.status !== 'active' || !row.plan.active ||
        row.providerCustomerId !== prepared.customerId ||
        row.providerSubscriptionId !== prepared.subscriptionId ||
        row.plan.stripePriceId !== prepared.priceId
      )
        throw new ConflictException('Subscription changed during Portal launch');
      const intent = await tx.stripeCheckoutIntent.findUnique({
        where: { checkoutSessionId: prepared.checkoutSessionId },
        select: { tenantId: true, planId: true, status: true },
      });
      if (!intent || intent.tenantId !== tenantId ||
          intent.status !== 'ready' ||
          intent.planId !== prepared.planId ||
          row.checkoutSessionId !== prepared.checkoutSessionId)
        throw new ConflictException('Checkout association changed');
      const recent = await tx.auditEvent.findFirst({
        where: {
          tenantId, action: 'billing.portal.created',
          createdAt: { gt: new Date(Date.now() - 30000) },
        },
        select: { id: true },
      });
      if (recent) throw new HttpException('Portal recently launched', 429);
      await this.tenants.audit(tx, actor, tenantId, 'billing.portal.created', row.id);
    });
    return { portalUrl: session.url };
  }
}
