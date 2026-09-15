import { Injectable } from '@nestjs/common';
import { Dependencies } from '../dependencies';

export interface AIContextSnapshot {
  business: {
    name: string;
    city: string | null;
    address: string | null;
    website: string | null;
    timezone: string;
    locale: string;
    currency: string;
  };
  preferences: {
    tone: string;
    useEmojis: boolean;
    useCustomerName: boolean;
    replyInCustomerLanguage: boolean;
    verbosity: string;
  } | null;
  policies: Record<string, string | number | null> | null;
  faqs: Array<{ question: string; answer: string; category: string | null }>;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    price: string;
    currency: string;
    durationMinutes: number;
    bookingEnabled: boolean;
  }>;
  customer: { displayName: string; language: string };
  conversation: {
    mode: string;
    language: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
}

export interface AIContextSource {
  load(
    tenantId: string,
    conversationId: string,
    customerId: string,
  ): Promise<AIContextSnapshot | null>;
}

@Injectable()
export class PrismaAIContextSource implements AIContextSource {
  constructor(private readonly deps: Dependencies) {}

  load(
    tenantId: string,
    conversationId: string,
    customerId: string,
  ): Promise<AIContextSnapshot | null> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const conversation = await tx.conversation.findFirst({
        where: {
          tenantId,
          id: conversationId,
          customerId,
          customer: { deletedAt: null },
        },
        select: {
          mode: true,
          language: true,
          customer: { select: { displayName: true, language: true } },
          tenant: {
            select: {
              name: true,
              city: true,
              address: true,
              website: true,
              timezone: true,
              locale: true,
              currency: true,
              configuration: {
                select: {
                  cancellation: true,
                  rescheduling: true,
                  lateness: true,
                  noShow: true,
                  payment: true,
                  refunds: true,
                  deposits: true,
                  minimumAge: true,
                  otherRules: true,
                  tone: true,
                  useEmojis: true,
                  useCustomerName: true,
                  replyInCustomerLanguage: true,
                  verbosity: true,
                },
              },
            },
          },
        },
      });
      if (!conversation) return null;
      const [faqs, services, newestMessages] = await Promise.all([
        tx.faq.findMany({
          where: { tenantId, active: true },
          select: { question: true, answer: true, category: true },
          orderBy: { createdAt: 'asc' },
          take: 30,
        }),
        tx.businessService.findMany({
          where: { tenantId, active: true, deletedAt: null },
          select: {
            id: true,
            name: true,
            description: true,
            category: true,
            price: true,
            currency: true,
            durationMinutes: true,
            bookingEnabled: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 50,
        }),
        tx.message.findMany({
          where: { tenantId, conversationId, messageType: 'text' },
          select: { direction: true, contentText: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 12,
        }),
      ]);
      const config = conversation.tenant.configuration;
      return {
        business: {
          name: conversation.tenant.name,
          city: conversation.tenant.city,
          address: conversation.tenant.address,
          website: conversation.tenant.website,
          timezone: conversation.tenant.timezone,
          locale: conversation.tenant.locale,
          currency: conversation.tenant.currency,
        },
        preferences: config
          ? {
              tone: config.tone,
              useEmojis: config.useEmojis,
              useCustomerName: config.useCustomerName,
              replyInCustomerLanguage: config.replyInCustomerLanguage,
              verbosity: config.verbosity,
            }
          : null,
        policies: config
          ? {
              cancellation: config.cancellation,
              rescheduling: config.rescheduling,
              lateness: config.lateness,
              noShow: config.noShow,
              payment: config.payment,
              refunds: config.refunds,
              deposits: config.deposits,
              minimumAge: config.minimumAge,
              otherRules: config.otherRules,
            }
          : null,
        faqs,
        services: services.map((service) => ({ ...service, price: service.price.toFixed() })),
        customer: conversation.customer,
        conversation: {
          mode: conversation.mode,
          language: conversation.language,
          messages: newestMessages.reverse().map((message) => ({
            role: message.direction === 'inbound' ? 'user' : 'assistant',
            content: message.contentText,
          })),
        },
      };
    });
  }
}
