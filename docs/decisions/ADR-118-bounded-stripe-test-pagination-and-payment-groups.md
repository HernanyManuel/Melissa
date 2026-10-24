# ADR-118 — Paginação limitada e proveniência de múltiplos pagamentos Stripe TEST

## Estado

Implementado em `feature/phase-8-inbox`, PR #7 *draft*, schema **76**. Confirmar o CI do HEAD final. Sem cobranças live, merge, deploy, enforcement de quotas, reembolsos executados ou entitlements.

## Problema

A ADR-117 verifica rigorosamente uma fatura com **um InvoicePayment** ligado a um PaymentIntent/Charge e observa os refunds/disputes dessa Charge. Porém, a Stripe pode devolver `has_more=true` em listas de InvoicePayments, refunds, disputes e credit notes, e uma fatura pode ter vários pagamentos parciais. Ignorar páginas cria falsos zeros; presumir que uma Charge isolada cobre toda a fatura confunde reconciliação com recebimento de dinheiro.

## Decisão A — Páginas sem falsos resultados completos

A função `readBoundedStripeList` percorre `starting_after` **somente a partir de IDs Stripe obtidos nas páginas anteriores**, com `MAX_STRIPE_LIST_PAGES=3` e `MAX_STRIPE_LIST_ITEMS=100`. Concede ao cliente Stripe test consultas `GET` em endpoints fixos `/v1/invoice_payments`, `/v1/refunds`, `/v1/disputes` e `/v1/credit_notes`; cada resposta individual conserva o limite de 128 KiB e timeout de 5 segundos já configurados. As listas normalizadas são entregues aos validadores das ADRs 116–117.

Cada página deve ter `object=list`, `data` array com até 100 registos, `has_more` booleano e IDs de recursos válidos e **únicos em todas as páginas**. Resposta malformada, repetição de ID, cursor inválido, página vazia com `has_more=true` ou falha HTTP/timeout lança erro; não é tratada como ausência de risco. Quando a lista ultrapassa o máximo de páginas/itens, o resultado conserva `has_more=true` e os verificadores existentes assinalam `deferred` em vez de uma reconciliação falsamente completa. O limite é deliberado; paginação arbitrariamente longa continuará a exigir política e orçamento operacional.

## Decisão B — Proveniência observacional de grupos de pagamentos

A migration 76 cria `stripe_test_invoice_payment_groups` e `stripe_invoice_payment_group_attempts`, append-only e protegidas com FORCE RLS, triggers anti-UPDATE/DELETE e acesso apenas ao papel independente `melissa_billing_invoice_verifier` (NOLOGIN por defeito). A API runtime, reconciler e dispatcher não recebem novos grants. A tabela tem FK à evidência imutável da invoice (ADR-115), tenant/subscription, hash SHA-256, número de pagamentos 2–8 e soma positiva observada, que deve corresponder ao valor da evidência original. As tentativas registam apenas motivos sanitizados `recorded/replayed/rejected/deferred`.

O operador invoca `pnpm --filter @melissa/backend stripe:payment-group-test in_...` somente com `NODE_ENV=test`, `STRIPE_TEST_PAYMENT_GROUP_ENABLED=true`, `STRIPE_TEST_SECRET_KEY=sk_test_...` e `BILLING_INVOICE_VERIFIER_DATABASE_URL`. A CLI executa uma revisão por vez, com role test e sem automatização.

A cadeia de confiança é **invoice assinada e verificada previamente → tenant/subscription/Checkout`ready`/price/currency ativos → consulta atual ao Stripe de invoice/subscription/InvoicePayments → PaymentIntent e Charge correspondentes a cada alocação**. Aceitam-se somente 2–8 InvoicePayments `paid`, `livemode=false`, com IDs `inpay_` distintos, PaymentIntents e Charges distintos, cliente/currency iguais e PaymentIntents `succeeded` com Charges capturadas/pagas. Cada PI e Charge deve ser exclusivamente correspondente à sua alocação (`amount_received` e `charge.amount` iguais ao `amount_paid` dessa InvoicePayment); montantes partilhados ou parcialmente atribuídos a várias invoices são deliberadamente rejeitados até existir política de reconciliação própria. A soma das alocações deve coincidir **exatamente** com `invoice.amount_paid` originalmente verificado. A identidade não provém de metadata nem do browser. Um digest estável dos IDs/alocações ordenados deduplica replays; mudanças subsequentes geram outra observação imutável.

## Não autorização e limites

A observação do grupo **não cobre refunds/disputes por todas as Charges**, disputas futuras, chargebacks, payouts, ledger do saldo Stripe, extratos bancários, créditos, fiscalidade, pro-rata ou validade contratual. Nem sequer um grupo com soma exata comprova settlement. O SQL fixa `refund_graph_verified=false`, `settlement_verified=false`, `financial_clearance=false` e `billable=false` com CHECK imutável; não habilita `billingVerified`, `automationEnabled` ou o gate da ADR-113. O novo grupo não é inserido nas tabelas de risco individual, evitando converter o total da invoice em reembolso atribuível a uma Charge.

## Verificação

Unitários de paginação cobrem cursor e URL fixa, segunda página, repetição de ID, lista incompleta, ausência de avanço, contagem superior a 100 e limite de três páginas; unitários de grupo cobrem montantes exatos e mudanças com novo hash, ordem estável, exclusividade de PI/Charge, outra invoice/cliente, duplicados, estado incorreto e `has_more`. Integração PostgreSQL real com mock Stripe, papel segregado e RLS verifica primeira inserção, replay, lista incompleta, cliente falso, grants, imutabilidade e flags negadas. **Stripe sandbox real e conciliação de múltiplas Charges com refunds ainda não executados.**

## Próximo incremento

Se necessário, implementar revisão de refunds/disputes **por cada Charge de grupo** com limites operacionais de consultas, snapshot de proveniência completo, validação conjunta de credit notes e demonstração de reversões no Stripe sandbox. Nenhuma dessas fases pode ativar a gate de entitlements sem autorização comercial e financeira independente.
