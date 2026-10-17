# ADR-121 — Fundação para observação de payout automático Stripe TEST

## Estado

**Parcial, schema 79.** Contrato puro, leitor GET Stripe TEST e testes unitários; não existe ainda CLI, operação orquestrada Stripe, integração PostgreSQL/RLS ou teste E2E de conta sandbox. A versão exigida de schema passa a **79**. O PR #7 continua draft.

## Decisão

A Stripe documenta o filtro `GET /v1/balance_transactions?payout=po_...` **apenas para payouts automáticos**. A sua utilização exige obter o payout diretamente no fornecedor com chave TEST, observar `automatic=true`, `reconciliation_status=completed` e recolher uma lista completa via paginação limitada. Os IDs de transação esperados têm de vir da validação segura de Charges de ADR-120, nunca do browser, metadata ou operador. Payout manual, falha, estados incompletos, divergência de moeda/source/net, lista truncada ou Charge ausente não demonstram atribuição: devolver deferred/rejected.

O módulo `stripe-test-payout-observation.ts` concretiza somente a decisão determinística **offline**, sem acesso à rede ou à BD. Aceita um objeto Stripe TEST verificado e uma lista já carregada e limitada; a futura camada privilegiada tem de provar origem, integridade, paginação e tenant antes de o invocar. Outros movimentos de conta podem coexistir num payout; por isso nem o somatório das Charges de uma invoice tem de coincidir com o montante total do payout.

Mesmo quando a Stripe comunica `paid` e `completed`, isto não é comprovativo bancário definitivo e pode haver reversões/falhas posteriores. `settlementVerified=false`, `billable=false`, `billingVerified=false`, `automationEnabled=false` e `billing_entitlement_activation_gate.enabled=false` mantêm-se obrigatórios. Sem novas permissões, pagamentos, deploy, merge ou alteração comercial.

## Próximo incremento da mesma ADR

Revalidar a cadeia Checkout→subscription→invoice→group→Charge→balance transaction; provar pertença do payout à mesma conta Stripe; verificador privilegiado que grava o ledger append-only já criado com FORCE RLS/grants mínimos e auditoria, testes de integração PostgreSQL, scripts manuais opt-in e CI completo no SHA final. Sem atribuição cross-tenant e sem extrapolação de disponibilidade para liquidação.

## CI

O primeiro commit da ADR-121 falhou no gate Prettier (backend), enquanto Flutter e Compose passaram. O incremento corretivo mantém `prettier-ignore` circunscrito às funções/fixtures densas desta observação, seguindo o precedente do parser ADR-120; não altera o contrato de segurança. Validar resultado do CI do commit corretivo antes de declarar aprovação.

## Incremento de persistência (schema 79)

A migration `20261017007900_stripe_test_group_payout_observations` cria observações e tentativas imutáveis, com FORCE RLS e grants apenas para `melissa_billing_invoice_verifier`. O INSERT só admite um grupo/tenant/invoice/subscription compatível com uma revisão ADR-120 cujas transactions estejam todas `available`; o net e a contagem têm de coincidir. Estes controlos SQL **não** constituem prova da relação Stripe payout→Charge: essa validação é obrigação do verificador privilegiado, ainda por implementar. Sem esse verificador, nenhuma CLI escreve snapshots. Impossível, por CHECK, marcar payout, settlement, financial clearance ou billable como true. Sem E2E Stripe real.

## Verificador TEST manual

`NODE_ENV=test STRIPE_TEST_PAYOUT_ENABLED=true pnpm --filter @melissa/backend stripe:payout-test in_... po_...` requer `STRIPE_TEST_SECRET_KEY` e `BILLING_INVOICE_VERIFIER_DATABASE_URL` do papel segregado. Reconsulta invoice/subscription/Checkout, pagamentos, PI, Charges e balance transactions, valida o digest ADR-120 já persistido, reconsulta payout e lista completa paginada e só então regista observação ou replay. Estados incompletos são deferred. A associação observada continua sem prova de entrada bancária. Faltam os testes PostgreSQL/RLS específicos e E2E Stripe TEST real; CI deste commit por verificar.

## Integração PostgreSQL/RLS

A suite existente `stripe-invoice-evidence.integration.test.ts` passou a exercitar também `reviewStripeTestAutomaticPayout` com provider Stripe simulado: gravação, replay, partial list, payout manual, source estrangeiro, auditoria, imutabilidade, grants mínimos, FORCE RLS e isolamento tenant. Estes testes dependem do CI; não representam sandbox real. Não há autorização de merge ou faturação live.

## Cobertura adicional de concorrência e pertença

A integração PostgreSQL inclui agora duas invocações simultâneas sobre a mesma invoice: o lock transacional força replay sem criar uma segunda observação. Os testes unitários confirmam que transações de outras origens podem coexistir no payout mas não compensam uma transação esperada em falta, e que IDs duplicados e valores líquidos inconsistentes são rejeitados. Permanecem pendentes testes E2E com conta Stripe TEST efetiva e evidência bancária de settlement (fora do âmbito desta ADR).
