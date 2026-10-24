# ADR-119 — Observação conjunta dos riscos por Charge de um grupo Stripe TEST

## Estado

Implementado na branch `feature/phase-8-inbox`, PR #7 draft, schema **77**. Validar CI verde no HEAD final. Não implementa cobrabilidade, clearing, reembolsos reais, merge ou deploy.

## Contexto

A ADR-118 regista grupos imutáveis de 2–8 InvoicePayments Stripe TEST, vinculados à mesma invoice, tenant, subscrição, Checkout e preço. A ADR-117 verifica refund/dispute numa única Charge, mas **não** cobre grupos com várias Charges. Sem analisar todas as Charges, a inexistência de risco num pagamento não pode ser interpretada como inexistência na fatura.

## Decisão

1. **CLI exclusivamente de teste:** `pnpm --filter @melissa/backend stripe:group-risk-test in_...`, somente com `NODE_ENV=test`, `STRIPE_TEST_GROUP_RISK_ENABLED=true`, `STRIPE_TEST_SECRET_KEY=sk_test_...` e `BILLING_INVOICE_VERIFIER_DATABASE_URL` do papel NOLOGIN-by-default `melissa_billing_invoice_verifier`. Nenhum processo automático e nenhuma alteração no API/Flutter.
2. **Confiança e revalidação:** a CLI busca a evidência de invoice já verificada, revalida tenant/subscrição/Checkout `ready`/preço e consulta novamente a subscrição e a invoice no Stripe. Consulta a lista completa limitada de InvoicePayments, depois PI/Charge e as duas listas (refunds, disputes) **de cada Charge**. Todos os identificadores vêm de respostas Stripe e da associação previamente verificada; não aceita cliente, tenant, Charge, PI ou refund provenientes de metadata ou de parâmetros de utilizador.
3. **Apenas grupos efetivamente observados:** o parser da ADR-118 reconstrói e valida o grafo completo de 2–8 pagamentos exclusivos, com montantes individuais iguais aos PI/Charges e soma de alocações igual à invoice. O hash desse grafo tem de coincidir com `stripe_test_invoice_payment_groups` append-only. Um grupo distinto ou ainda não observado é rejeitado.
4. **Verificação individual de riscos:** para cada alocação, aplica as validações estritas do parser ADR-117 à Charge associada: mesmo customer, moeda, PI, Charge, estado TEST, IDs únicos, refunds válidos e disputes válidas. A soma observada separa refunds `pending/ requires_action` de `succeeded`; conta as disputes por estado. O parser reutiliza uma vista **temporária, exclusivamente interna, do montante de cada alocação** para validar limites por Charge; não a guarda como invoice real nem cria recibo. A soma de refunds concluídos e pendentes não pode ultrapassar o montante originalmente observado.
5. **Sem falsos zeros:** os leitores da ADR-118 limitam listas paginadas a 3 páginas/100 objetos por recurso, rejeitando cursores malformados ou repetidos. Qualquer lista parcial, timeout ou falha de uma única Charge resulta em `deferred`; não grava uma revisão que pareça completa. Faturas com mais de 8 pagamentos ou alocações partilhadas continuam não suportadas.
6. **Snapshot financeiro não autorizativo:** a migration 77 cria `stripe_test_group_charge_risk_reviews`, com FK a grupo previamente observado, invoice e tenant/subscrição, digest SHA-256 do grupo e dos riscos por pagamento ordenados, número de Charges, refunds, valores em estado `succeeded` e `pending`, disputes e unresolved. `(group_id,snapshot_sha256)` deduplica replays; alterações de estado criam outro registo. `stripe_group_charge_risk_attempts` regista `recorded/replayed/deferred/rejected` com razões sanitizadas.
7. **Separação técnica de papéis:** FORCE RLS em ambas tabelas, SELECT/INSERT estritamente limitados ao verificador offline; runtime API, dispatcher e reconciler não têm grants. Triggers rejeitam UPDATE/DELETE. A migration exige FKs e a correspondência entre tenant, subscription, group e invoice original. As colunas `refund_graph_verified`, `settlement_verified`, `financial_clearance` e `billable` são **obrigatoriamente false** por CHECK, mesmo com zero refunds ou todas disputes terminadas.
8. **Limitações:** esta observação NÃO garante settlement bancário ou que refunds/disputas futuros sejam impossíveis; não trata balance transactions, payouts, impostos, chargebacks fora da janela, créditos, faturas com alocações partilhadas, múltiplos ciclos, nem reconciliação real em conta Stripe sandbox. Nem passa informações de montantes à API. `billingVerified=false`, `automationEnabled=false` e o gate de entitlements da ADR-113 continuam fechados.

## Testes

Unitários de grupo/riscos cobrem duas Charges sem riscos, refunds pendentes/concluídos em Charges distintas, mudança de estado gerando novo hash, disputa por Charge, paginação incompleta e falsificação de customer/PI/Charge. Integração PostgreSQL/RLS real com provider simulado cobre papel restrito, primeiro snapshot, replay, nova observação, lista parcial `deferred`, Charge estrangeira `rejected`, triggers, grants e isolamento entre tenants. O CI no HEAD final valida ou invalida este incremento.

## Próximo trabalho

Verificar comportamento real da conta Stripe TEST, créditos/estornos conjuntos por pagamento, políticas de alocações partilhadas, reconciliação de saldo e payouts e janelas de risco. Nenhuma revisão pode ser tratada como prova suficiente de clearance financeiro ou convertida em acesso pago sem ADR de segurança e política comercial explícitas.
