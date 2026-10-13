# ADR-107 — Papel PostgreSQL de mínimos privilégios para reconciliação Stripe test

## Situação

Phase 9, schema **66**, PR #7 draft na branch `feature/phase-8-inbox`. A ADR-106 usava `MIGRATION_DATABASE_URL` privilegiada, apesar de os eventos Stripe serem apenas um gatilho assinado e o reconciliador poder aceitar *somente* associações já verificadas. Separar credenciais elimina um vetor de alteração indevida de contas ou planos.

## Decisão e modelo de ameaça

1. `melissa_billing_reconciler` é um papel PostgreSQL independente `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOLOGIN`. `infra/scripts/runtime-role.sql` e o bootstrap Compose criam-no sem segredo nem LOGIN. Ativação controlada só em base descartável de testes com `infra/scripts/billing-reconciler-login.sql` e variável psql `reconciler_password` independente; produção não deve correr este script. No CI o password é descartável e a URL é **BILLING_RECONCILER_DATABASE_URL**, distinta de `DATABASE_URL` da API e `MIGRATION_DATABASE_URL`.
2. RLS `ENABLE/FORCE` continua aplicada a `subscriptions`, `stripe_webhook_events` e `stripe_reconciliation_attempts`. Políticas explícitas para o novo papel concedem SELECT dos eventos já recebidos (incluindo o JSON sensível indispensável apenas ao reconciliador), SELECT de subscrições existentes, UPDATE apenas com `provider='stripe'`, e SELECT/INSERT da auditoria. Não há UPDATE/DELETE dos eventos nem UPDATE/DELETE da auditoria. `plans` concede SELECT apenas em `id,stripe_price_id`, nunca preço base, custos, catálogo ou escrita.
3. `subscriptions` concede UPDATE apenas nas colunas `status,current_period_start,current_period_end,cancel_at_period_end,trial_end,updated_at`. NÃO concede mutação de `tenant_id,id,plan_id,provider_customer_id,provider_subscription_id`, nem INSERT/DELETE da subscrição. Não concede acesso à tabela `tenants`, aos clientes, utilizadores, memberships ou serviços. A operação verifica também `current_user='melissa_billing_reconciler'` e atributos de rol antes de ler um evento, recusando URLs administrativas mesmo durante testes. O script não tem fallback para MIGRATION_DATABASE_URL.
4. O papel **não** efetua HTTP ou recebe Stripe SDK automaticamente. `NODE_ENV=test` e `STRIPE_TEST_RECONCILE_ENABLED=true` continuam obrigatórios; chaves `sk_live` continuam rejeitadas. A API continua a usar `melissa_runtime`, sem grants novos. O bloqueio de acesso comercial `billingVerified=false / automationEnabled=false` e o blocker de onboarding não mudam.
5. Auditar cada tentativa via `stripe_reconciliation_attempts` mantém-se transacional; o modelo de evento original é imutável. Os dados sensíveis não vão para logs do comando; a ligação de teste com privilégios mínimos é uma barreira adicional, não substitui controlo de segredos e rotação em produção.

## Verificação

A suite integrada usa **duas ligações reais PostgreSQL separadas**: administrador apenas para preparar fixtures e verificar auditoria; papel restrito para cada chamada do reconciliador. Demonstra que uma chamada com admin é recusada, que a reconciliação de cliente/price pré-associados funciona com `FOR UPDATE` sem bypass RLS, que `metadata.tenant_id` forjado não altera outra empresa, e que SQL privilege checks impedem escrever em tenant, customer binding, plano, inbox e audit; valida também ausência de direitos `billing` no role normal da API. Backend tests, worker/restart, Flutter e Compose têm de passar no CI do commit final.

## Pendentes

Checkout Stripe test real e ligação inicial de customer/subscription/tenant verificada, role e credenciais seguras em hosting, calendário de reconciliação com retry/dead-letter e idempotência, quota/usage ledger, taxes/proration e provas com Stripe test CLI. Não há worker nem deploy ativado. Os estados de Stripe não dão direito a automação até existir `EntitlementService` transacional.
