import {
  BadRequestException, ConflictException, Injectable,
  NotFoundException, ServiceUnavailableException, Inject,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CONFIG, Configuration } from '../config';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';
import { CheckoutDto } from './checkout.dto';
import { StripeCheckoutGateway, CheckoutPlanPrice } from './stripe-test-checkout-provider';

@Injectable()
export class StripeCheckoutService {
  constructor(
    private readonly tenants: TenantService,
    private readonly gateway: StripeCheckoutGateway,
    @Inject(CONFIG) private readonly config: Configuration,
  ) {}

  async create(actor: Actor, tenantId: string, input: CheckoutDto) {
    if (this.config.STRIPE_TEST_CHECKOUT_ENABLED !== 'true')
      throw new NotFoundException();

    // Serialize all checkout mutations with the normal tenant membership
    // lock. A replay reuses the persisted provider idempotency key, never
    // trusts a Stripe tenant_id metadata field, and cannot switch plans.
    const prepared = await this.tenants.scoped(actor, tenantId, 'billing:write', async (tx) => {
      if (await tx.tenantSubscription.findUnique({
        where: { tenantId }, select: { id: true },
      })) throw new ConflictException('Subscription already linked');
      const plan = await tx.billingPlan.findUnique({
        where: { id: input.planId },
        select: {
          id: true, active: true, stripePriceId: true, stripeProductId: true,
          basePrice: true, billingInterval: true, currency: true,
        },
      });
      if (!plan?.active || !plan.stripePriceId || !plan.stripeProductId)
        throw new BadRequestException('Unavailable plan');
      const now = new Date();
      await tx.stripeCheckoutIntent.updateMany({
        where: { tenantId, status: { in: ['pending', 'ready'] }, expiresAt: { lte: now } },
        data: { status: 'expired', updatedAt: now },
      });
      let intent = await tx.stripeCheckoutIntent.findUnique({
        where: { tenantId_requestId: { tenantId, requestId: input.requestId } },
      });
      if (intent && (intent.planId !== plan.id ||
          intent.stripePriceId !== plan.stripePriceId || intent.status === 'expired'))
        throw new ConflictException('Checkout request cannot be reused');
      if (!intent) {
        const inProgress = await tx.stripeCheckoutIntent.findFirst({
          where: { tenantId, status: { in: ['pending', 'ready'] } },
          select: { id: true },
        });
        if (inProgress) throw new ConflictException('Checkout already pending');
        intent = await tx.stripeCheckoutIntent.create({
          data: {
            id: randomUUID(), tenantId, planId: plan.id,
            requestId: input.requestId, stripePriceId: plan.stripePriceId,
            status: 'pending', expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        await this.tenants.audit(tx, actor, tenantId, 'billing.checkout.created', intent.id);
      }
      const price: CheckoutPlanPrice = {
        priceId: plan.stripePriceId, productId: plan.stripeProductId,
        amount: plan.basePrice.toString(), currency: plan.currency,
        interval: plan.billingInterval,
      };
      return { intent, price };
    });

    if (prepared.intent.status === 'ready' && prepared.intent.checkoutUrl)
      return { checkoutUrl: prepared.intent.checkoutUrl, expiresAt: prepared.intent.expiresAt };

    // Stripe calls happen OUTSIDE the DB transaction. Failed or timed-out
    // calls leave one durable pending intent which the same requestId retries.
    let session;
    try {
      await this.gateway.validatePrice(prepared.price);
      session = await this.gateway.createSession({
        intentId: prepared.intent.id, tenantId,
        priceId: prepared.price.priceId,
        origin: this.config.STRIPE_TEST_CHECKOUT_RETURN_ORIGIN!,
        expiresAt: prepared.intent.expiresAt,
      });
    } catch {
      throw new ServiceUnavailableException('Stripe test checkout unavailable');
    }
    if (session.expiresAt.getTime() !==
        Math.floor(prepared.intent.expiresAt.getTime() / 1000) * 1000)
      throw new ServiceUnavailableException('Checkout expiration mismatch');

    // Membership may have been revoked while Stripe responded. Re-check
    // current RBAC/RLS, plan identity and expiry before publishing the URL.
    const result = await this.tenants.scoped(actor, tenantId, 'billing:write', async (tx) => {
      const row = await tx.stripeCheckoutIntent.findUnique({
        where: { id: prepared.intent.id },
      });
      if (!row || row.tenantId !== tenantId || row.status !== 'pending' ||
          row.expiresAt <= new Date() || row.planId !== input.planId ||
          row.stripePriceId !== prepared.price.priceId)
        throw new ConflictException('Checkout no longer available');
      if (await tx.tenantSubscription.findUnique({
        where: { tenantId }, select: { id: true },
      })) throw new ConflictException('Subscription already linked');
      const changed = await tx.stripeCheckoutIntent.updateMany({
        where: { id: row.id, tenantId, status: 'pending', expiresAt: { gt: new Date() } },
        data: {
          status: 'ready',
          checkoutSessionId: session.id, checkoutUrl: session.url,
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) throw new ConflictException();
      await this.tenants.audit(tx, actor, tenantId, 'billing.checkout.ready', row.id);
      return { checkoutUrl: session.url, expiresAt: row.expiresAt };
    });
    return result;
  }
}
