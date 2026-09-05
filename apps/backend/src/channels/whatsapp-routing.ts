import { Prisma, PrismaClient } from '@prisma/client';

interface Route {
  tenant_id: string;
  channel_id: string;
}

export class WhatsAppRouteUnavailable extends Error {
  constructor() {
    super('WhatsApp route unavailable');
  }
}

// Internal service: call only AFTER signature verification. integrationKey comes from
// server configuration selecting the verification secret, NEVER from webhook payload/query.
export class WhatsAppRouting {
  constructor(
    private readonly db: PrismaClient,
    private readonly integrationKey: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(integrationKey)) throw new WhatsAppRouteUnavailable();
  }

  async scoped<T>(
    accountId: string,
    phoneId: string,
    run: (
      tx: Prisma.TransactionClient,
      route: { tenantId: string; channelId: string },
    ) => Promise<T>,
  ): Promise<T> {
    if (!/^\d{1,32}$/.test(accountId) || !/^\d{1,32}$/.test(phoneId))
      throw new WhatsAppRouteUnavailable();
    // This minimal registry is the only global read. Tenant/customer/channel payloads retain RLS.
    const [route] = await this.db.$queryRaw<Route[]>`
      SELECT tenant_id,channel_id FROM whatsapp_routes
      WHERE integration_key=${this.integrationKey} AND account_id=${accountId} AND phone_id=${phoneId}`;
    if (!route) throw new WhatsAppRouteUnavailable();
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${route.tenant_id},true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${route.tenant_id}::uuid FOR UPDATE`;
      // Recheck after waiting for the tenant lock; provisioning/revocation must use this lock too.
      const [current] = await tx.$queryRaw<Route[]>`
        SELECT tenant_id,channel_id FROM whatsapp_routes
        WHERE integration_key=${this.integrationKey} AND account_id=${accountId} AND phone_id=${phoneId}`;
      if (
        !current ||
        current.tenant_id !== route.tenant_id ||
        current.channel_id !== route.channel_id
      )
        throw new WhatsAppRouteUnavailable();
      const channel = await tx.channelConnection.findFirst({
        where: {
          tenantId: route.tenant_id,
          id: route.channel_id,
          channelType: 'whatsapp',
          mode: 'live',
          status: 'active',
          externalAccountId: accountId,
          externalPhoneId: phoneId,
        },
        select: { id: true },
      });
      if (!channel) throw new WhatsAppRouteUnavailable();
      return run(tx, { tenantId: route.tenant_id, channelId: route.channel_id });
    });
  }
}
