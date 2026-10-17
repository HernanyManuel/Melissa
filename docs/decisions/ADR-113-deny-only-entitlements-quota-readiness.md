# ADR-113 — Política deny-only de entitlements e diagnóstico de quotas

## Estado

Implementação Phase 9 em `feature/phase-8-inbox` / PR #7 *draft*, schema **71**. Confirmar CI e commit final antes de declarar validação. Nenhuma cobrança live, entitlement, merge ou deploy é autorizado.

## Problema e decisão

As ADRs 104–112 permitiram catálogo, subscrições Stripe test e sessão de Checkout/Portal controlada; porém, uma subscrição `status=active`, um preço publicado, um redirect ou uma métrica de uso nunca provam que a Melissa pode executar trabalho pago. A especificação §§42–46 exige política de entitlements e quotas com billing verification, mas definição de *conversa faturável*, overages, trial/grace, localização e ledger de pagamentos ainda não está aprovada.

Esta fatia distingue explicitamente:

1. **Prova e bloqueios de elegibilidade:** um avaliador determinístico, `evaluateCommercialEntitlements`, recebe snapshot de subscrição/plano, associação local de Checkout e período; identifica `missing_subscription`, `untrusted_checkout`, `subscription_not_active`, `subscription_period_invalid`, `plan_unavailable`, entre outros. A origem da verdade não é metadata do Stripe. A verificação comercial/ledger ainda não existe, pelo que `billing_verification_missing` e `billable_usage_undefined` bloqueiam todas as avaliações.
2. **Trava estrutural independente:** migration 71 cria `billing_entitlement_activation_gate` com apenas a chave `paid_automation`, `enabled=false` e `policy_version=1`, protegida com CHECK **`enabled=FALSE`**, FORCE RLS, SELECT mínimo ao papel runtime e **nenhuma permissão de escrita**. Não basta uma alteração administrativa ou flag para ativar acesso. No futuro, a remoção explícita dessa restrição exige migration revisada e novo código de autorização. Se a linha estiver ausente/corrompida, o endpoint falha de forma fechada.
3. **Endpoint só de diagnóstico:** `GET /api/v1/tenants/:tenantId/billing/entitlements` exige AuthGuard + `TenantService.scoped(..., 'billing:read')`, portanto owner/admin. Dentro da transação RLS do tenant lê a subscrição/Checkout e conta somente **staff ativos** e **canais ativos não desconectados**. Devolve `quotaPreview` com contagem observada, limite do plano ativo e `exceeded`. O limite é informação, **não** uma reserva transacional de quota. Se não há plano ativo, `limit=null`.
4. **Métricas não definidas:** conversas, mensagens e localizações retornam `measured=false`, `used=null`, `limit=null` e `enforceable=false`, em vez de inventar um contador faturável. A estrutura de localizações ainda não está modelada como unidade comercial.
5. **Bloqueio absoluto:** `decision.allowed=false`, `automationEnabled=false` e `billingVerified=false` em todas as combinações de estado, até nos testes com uma gate hipoteticamente aberta. Nenhum consumidor de mensagens, worker, tool, canal ou onboarding utiliza esta avaliação para ativar work pago. O `GET /billing/subscription` continua com o contrato conservador anterior.
6. **Proteção e ausência de mutações:** o endpoint não aceita payloads de alteração ou quota, não revela IDs Stripe, não armazena eventos financeiros ou custos nem grava contadores. É vedado transformar observações de staff/canais em autorização a contratar recursos ou em faturação.

## Verificação

Testes unitários de política/quotas provam resultados fail-closed para falta de subscrição, status trial/past_due, datas inválidas, planos desativados, Checkout errado, gate hypotética e billing verification hipotética. Testes HTTP/RBAC com PostgreSQL/RLS real verificam 401/403/404, isolamento de empresas, contagem de staff/canais, limites e excesso, quotas não mensuráveis, nenhuma referência Stripe no JSON, ausência de operações de escrita, a restrição DB CHECK `enabled=false`, grants e FORCE RLS. O CI deve estar verde no SHA final.

## Próximo incremento

Definir formalmente evento comercial de conversa, período de faturação, ledger fiável de invoices/settlement, políticas de trial/grace/cancelamento, reservas atómicas de quota com proteção de concorrência e IDs de utilização idempotentes. Nenhum deles foi implementado nesta ADR. A futura passagem de `deny-only` a `allow` depende de uma decisão de produto/segurança explícita, E2E Stripe sandbox, controlos de quota e mudança de migration aprovada.
