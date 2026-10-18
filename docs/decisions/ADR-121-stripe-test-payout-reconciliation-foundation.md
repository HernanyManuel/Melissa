# ADR-121 — Observação restrita de payouts automáticos Stripe TEST

## Estado — implementação e CI concluídos; E2E externo pendente

Schema **79**, HEAD de validação `9335048e5a124d91169634d13a0c7ea7a9659989`.
GitHub Actions [#39075192879](https://github.com/HernanyManuel/Melissa/actions/runs/39075192879): backend, Flutter e Compose **success**.
PR #7 mantém-se **draft**. Este estado não implica aprovação de lançamento, de faturação ou de liquidação.

## Decisão e limites de segurança

Apenas um payout **automático** Stripe TEST pode ter as balance transactions enumeradas pelo filtro `GET /v1/balance_transactions?payout=po_...`. A camada privilegiada lê o payout e a lista completa, paginada e limitada; revalida a cadeia de confiança Checkout → subscrição → invoice → InvoicePayments → PaymentIntents → Charges → balance transactions. O grupo e o balanço já observados nas ADR-118 e ADR-120 têm de coincidir com invoice, tenant, subscrição, contagem e valores. Identificadores esperados nunca são recebidos do browser, da metadata ou de um operador.

O parser determinístico só observa quando `livemode=false`, `automatic=true`, `status=paid`, `reconciliation_status=completed` e todas as transações esperadas surgem com `source`, moeda e `net` coincidentes. Paginação incompleta, payout manual, estados intermédios ou transações em falta não autorizam observação. Movimentos de outras origens podem pertencer ao payout e não substituem as transações do grupo. Não se exige que o montante total do payout seja igual ao subtotal da invoice.

Mesmo um payout Stripe com estado `paid` não comprova entrada bancária definitiva. Os CHECKs da BD obrigam `payout_verified=false`, `settlement_verified=false`, `financial_clearance=false` e `billable=false`. A política de entitlements permanece **deny-only**; `billing_entitlement_activation_gate.enabled=false`.

## Implementação

- `stripe-test-payout-observation.ts`: validação e digest determinístico SHA-256, sem I/O.
- `stripe-test-payout-reader.ts`: GET Stripe TEST com URL fixa, validação de IDs e paginação limitada.
- `stripe-test-payout-verifier.ts`: papel `melissa_billing_invoice_verifier`, revalidação de origem e titularidade, `pg_advisory_xact_lock` por invoice, gravação append-only e tentativas auditadas; replays seguros.
- `apps/backend/scripts/review-stripe-test-payout.ts`: execução **manual**, apenas `NODE_ENV=test`, `STRIPE_TEST_PAYOUT_ENABLED=true`, chave `sk_test_` e URL segregado `BILLING_INVOICE_VERIFIER_DATABASE_URL`. Invocação: `pnpm --filter @melissa/backend stripe:payout-test in_... po_...`.
- Migration `20261017007900_stripe_test_group_payout_observations`: ledger e auditoria imutáveis, `FORCE ROW LEVEL SECURITY`, INSERT de colunas estritamente limitadas ao verificador e sem grants à API. Requer uma revisão ADR-120 com todas as transações `available`.

## Provas automatizadas verificadas

O CI **verde** da execução #39075192879 cobre testes unitários e a integração PostgreSQL com Stripe simulado: observação e replay, duas execuções concorrentes sobre a mesma invoice sem duplicação, listas parciais, payout manual, transação estrangeira, IDs duplicados, moeda/source/net inconsistentes, imutabilidade, FORCE RLS, privilégios mínimos e isolamento entre tenants. O teste real de Stripe TEST **não** foi executado.

## Bloqueios e trabalhos futuros

Ainda faltam validação contra uma conta Stripe TEST configurada com payouts automáticos e dados apropriados, execução supervisionada da CLI contra essa conta, avaliação de anomalias reais da API/paginação e revisão operacional do modelo de conta Stripe. Não há prova de liquidação bancária, nem autorização para cobrança LIVE ou entitlements pagos. Não fazer merge/deploy sem decisão explícita posterior.
