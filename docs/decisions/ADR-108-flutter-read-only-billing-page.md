# ADR-108 — Consulta de faturação no Flutter sem conceder direitos comerciais

## Estado

Implementado na Phase 9 sobre `feature/phase-8-inbox` (PR #7 draft), **schema 66 inalterado**. Validação funcional: [CI #38520032622](https://github.com/HernanyManuel/Melissa/actions/runs/38520032622) integralmente verde no commit `215527ae8156fb4bf34b0ec8627eccdbf2cfa0ef`: backend (formatação/lint/TypeScript, testes unitários e integração PostgreSQL/RLS/Redis com worker real, OpenAPI e audit), Flutter (gen-l10n, análise estrita, widget tests, build Web) e Compose (readiness). O primeiro CI identificou apenas uma lista vazia sem tipo explícito no novo teste Dart, corrigida antes da aprovação. O ecrã é read-only, sem checkout, cobrança, envio a fornecedores ou ações comerciais.

## Contexto

A ADR-104 expõe `GET /api/v1/tenants/:tenantId/billing/plans` e `/billing/subscription`, limitados no servidor a `billing:read` (owner/admin). ADRs 105–107 acrescentaram a receção e a reconciliação manual Stripe test, mas **ainda não existe** um contrato comercial publicável, `EntitlementService`, quota/ledger ou Checkout. Um estado `active` visível na snapshot não é prova de direito de acesso.

## Decisão

1. Criar `BillingPage` em `/billing/:tenantId`, acessível a partir de `/account` somente quando o papel apresentado da empresa é owner/admin. **A interface não constitui controlo de acesso**: a API continua a validar sessão/RBAC/RLS e responde 401/403/404 independentemente da navegação.
2. O ecrã faz **apenas pedidos GET** à API existente e exibe planos publicados, preço/moeda/intervalo e limites, snapshot de subscrição (ou ausência) e período/cancelamento/trial; valores vêm da base de dados, sem constantes de preços ou identificadores Stripe. Não existem botões de compra, Portal, atualização de subscrição, ativação ou cobrança.
3. O aviso de automação paga desativada é constante. Se a resposta da API não contiver explicitamente `billingVerified=false` e `automationEnabled=false`, não apresentar a informação comercial como válida: erro genérico e sem listagem. Mesmo `subscription.status=active` não ativa a IA, independentemente da aparência do cartão.
4. Ao carregar/recarregar, limpar a projeção anterior; os pedidos de catálogo e subscrição são sequenciais e tratados como um único snapshot de UI. Geração/tenant ID e `mounted` impedem um pedido antigo de reintroduzir informação sensível de outra empresa; 401/403/404 mostram erro de acesso e apagam a informação, demais falhas mostram erro genérico. Botão de refresh seguro.
5. Ecrã rolável a 360 px, pt/en/es/fr/it/de, e testes de widget com `IdentityApi` injetável. Nunca imprimir erros de fornecedor ou referências Stripe em UI. Os valores exibidos de preço representam *catálogo*, não fatura emitida ou montante com impostos garantidos.

## Verificação

Testes cobrindo tenant scoped GET-only, planos e quotas, catálogo vazio/subscrição nula, `status=active` com cancelamento e aviso inalterado, erro 403 na segunda chamada que limpa a primeira e repetição após recuperação, e resposta inesperada com entitlements ativos que força fail-closed. CI funcional aprovado: execução #38520032622, Flutter + backend + Compose.

## Limites

Faltam gestão de preços/plano por operador, confirmação real de contrato Stripe test, Checkout/Portal, reconciliação agendada, notificações de cobrança, invoices, consumos, CostGuard, quotas e EntitlementService transacional. Este incremento não muda o schema 66 nem altera os pressupostos de segurança das ADRs 104–107.
