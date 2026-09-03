import { Prisma } from '@prisma/client';

// Caller holds the tenant row lock after validating the signed provider route.
// Never accept a tenant/customer ID supplied by the external sender.
export async function resolveInboundCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  senderId: string,
) {
  if (!/^[1-9]\d{6,14}$/.test(senderId)) throw new Error('Unsupported sender identity');
  const phoneE164 = `+${senderId}`;
  const existing = await tx.customer.findUnique({
    where: {
      tenantId_phoneE164: { tenantId, phoneE164 },
    },
  });
  if (existing?.deletedAt) throw new Error('WhatsApp customer archived');
  if (existing) return existing;
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { locale: true },
  });
  const customer = await tx.customer.create({
    data: {
      tenantId,
      phoneE164,
      displayName: phoneE164,
      language: tenant.locale,
      marketingConsentStatus: 'unknown',
      whatsappOptInStatus: 'unknown',
    },
  });
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorType: 'whatsapp',
      action: 'customer.whatsapp_created',
      targetId: customer.id,
    },
  });
  return customer;
}
