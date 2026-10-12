# ADR-104 — Catálogo de planos e snapshot de subscrições read-only

## Estado

Phase 9, primeira fatia no PR #7 draft (`feature/phase-8-inbox`), schema 63. CI final por confirmar. Sem merge, deploy, credenciais ou cobrança Stripe.

## Contexto e decisões de produto

A especificação §§42–46 exige `plans`, `subscriptions` e enforcement de limites, com Stripe como fonte externa. Os exemplos Starter/Pro/Business não são preços publicados; a definição de conversa faturável, overage, trial/grace, impostos e proration continua pendente (§43, §44 e `docs/billing.md`). Persistir um estado de pagamento por redirect HTTP seria inseguro, e um estado `active` inserido sem prova assinada do provider não pode permitir uso premium.

## Decisão técnica

1. Migration schema **63** cria `plans` global com `key`, `name`, moeda ISO-4217 sintática, `NUMERIC(20,6)` para preço base e overage, `billing_interval=month|year`, quotas inteiras não negativas de conversas, mensagens opcionais, staff, canais e localizações, `features JSONB` objeto, mapeamentos Stripe opcionais, `active=false` por defeito e datas. Existe UNIQUE parcial para preço Stripe não nulo. Não há preço ou plano seeded nem um plano de demonstração prometido ao cliente.
2. `subscriptions` tem `(tenant_id,id)` como PK, UNIQUE por tenant para **uma snapshot reconciliada**, UNIQUE para `(provider,provider_subscription_id)`, FK tenant/plan, provider limitado a `stripe`, estados Stripe allowlisted, período coerente e flags de cancelamento/trial. A escolha de **snapshot única** é intencional nesta fundação: reconciliação e histórico de eventos serão tabelas separadas no incremento de webhooks, não duas subscrições simultâneas confundidas com entitlement.
3. A subscrição usa `ENABLE/FORCE ROW LEVEL SECURITY`, política read-only com `app.tenant_id`. A aplicação recebe somente grants SELECT nas colunas necessárias: zero grants INSERT/UPDATE/DELETE em ambas as tabelas, zero SELECT dos IDs Stripe. Apenas o role privilegiado de migração (futuro consumidor provider estritamente autorizado) pode provisionar. Sem fallback mock ou endpoint de escrita.
4. `TenantService.scoped(actor,tenantId,'billing:read')` valida sessão e membership e serializa com lock de tenant. `billing:read` existe apenas para owner/admin, não manager/staff/viewer. O catálogo expõe somente planos ativos com projeção allowlisted e decimais serializados como strings; a API de subscrição expõe `null` quando ausente ou status/período/plan públicos quando há snapshot. Nenhum identificador externo ou credencial é devolvido.
5. Até existir verificação Stripe real e um `EntitlementService` integrado em cada mutação paga, `entitlements.automationEnabled=false` e `billingVerified=false` **sempre**, mesmo se um fixture administrativo marcar `status=active`. `activation.allowed=false` e blocker `subscription` não mudam. `Dependencies.ready` requer `schema_version=63` e role runtime não-owner.

## Verificação

Teste integrado próprio registado em `pnpm test:integration`: PostgreSQL + Redis reais, duas contas/tenants, 401 sem token, 404 outro tenant, 403 viewer, catálogo vazio antes de configuração, catálogo com preço/configuração verificados na DB, ocultação de planos inativos e referências Stripe, snapshot por tenant, 404 nas tentativas POST, RLS forçada, ausência de grants write, SELECT sem tenant vazio e ativação bloqueada. Fixture administrativo cria uma snapshot `active` para provar **explicitamente** que nenhuma funcionalidade paga é desbloqueada.

## Limites e próximos passos

Não é billing pronto, nem autoriza publicação live. Falta plan admin seguro, webhook verified + inbox imutável + outbox/reconciler, token e assinatura Stripe test, Checkout/Portal, invoices, quotas/cost guard, UI completa e E2E. Os dados de price/product IDs reais e o tratamento de grace/periodo terão de ser aprovados antes de qualquer cobrança. A UI só pode exibir os dados, nunca conceder entitlement. Nenhum deploy/merge ou mudança de workers live.
