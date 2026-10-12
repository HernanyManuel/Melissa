# ADR-107 — Papel dedicado de mínimos privilégios para o reconciliador Stripe test

## Âmbito

Continuação da ADR-106 no contexto da Phase 9. A reconciliação permanece **manual, apenas em ambiente test**, sem agendamento, Checkout, cobrança ou autorizações comerciais; a base de dados avança de schema 65 para 66.

## Problema

A ADR-106 usa `MIGRATION_DATABASE_URL` para aceder a snapshots Stripe previamente ligados. Uma credencial administrativa da BD pode modificar qualquer tenant, plano ou mensagem e bypassar RLS. Mesmo numa ferramenta de teste, não deve ser a credencial de execução de um reconciliador. O `melissa_runtime` da API, por outro lado, não pode ler JSON privado de eventos nem atualizar subscrições.

## Decisão

1. O administrador cria a role `melissa_stripe_reconciler`, `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`, com password entregue via secret externo à instrução `infra/scripts/stripe-reconciler-role.sql`. Provisionamento anterior à migration é obrigatório. Não existe password por omissão e os exemplos do CI são descartáveis.
2. A migration 66 adiciona políticas RLS específicas para essa role (sem relaxar as políticas `melissa_runtime`). A role pode SELECT de eventos test assinados incluindo payload, SELECT de `plans`, SELECT de `subscriptions` já associadas ao provider `stripe`, UPDATE **apenas** de `status`, datas de período/trial, cancelamento e `updated_at`, e SELECT/INSERT do audit `stripe_reconciliation_attempts`. Não pode INSERT/DELETE subscrições, publicar planos, alterar `tenant_id`, `plan_id`, `provider_customer_id`, `provider_subscription_id`, UPDATE/DELETE de eventos ou auditorias, nem ler tabelas `tenants`.
3. O CLI `stripe:reconcile-test` passa a exigir `STRIPE_TEST_RECONCILE_DATABASE_URL` cujo utilizador de URL seja `melissa_stripe_reconciler`. `MIGRATION_DATABASE_URL` não é utilizado no comando. Permanecem `NODE_ENV=test`, `STRIPE_TEST_RECONCILE_ENABLED=true` e chave `sk_test_` estrita. O HTTP e os workers públicos não recebem essa credencial.
4. O teste de reconciliação usa um PrismaClient com credenciais de migração **somente para criar fixtures e ler provas**, e um segundo PrismaClient com role restrita **para todas as chamadas reais ao reconciliador**. Verifica SUPERUSER/BYPASSRLS desativados, ausência de direitos sobre tenant e alterações proibidas, assim como UPDATE autorizado apenas em colunas de período e estado. Mantém testes de replays, payload adversarial, correspondência de IDs e periodização Stripe Basil.
5. `Dependencies.ready` exige schema 66; sem role provisionada ou grants a migração falha em vez de criar um reconciliador com privilégios máximos.

## Limitações

Trata-se de uma role offline com visão transversal sobre *bindings de subscrições Stripe*. Ela não é uma credencial apropriada para utilização na API pública. Para um worker permanente, serão necessários circuito operacional auditado, gestão e rotação de segredos, controlo de execução, quotas, retrais/observabilidade, controlo explícito de entitlement e testes E2E com Stripe real em test-mode. Estas alterações não resolvem a aquisição do primeiro binding Stripe: só Checkout verificado poderá estabelecê-lo. Não há merge nem deploy.
