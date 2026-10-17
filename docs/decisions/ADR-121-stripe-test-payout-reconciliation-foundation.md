# ADR-121 — Fundação para observação de payout automático Stripe TEST

## Estado

**Parcial, sem schema novo.** Contrato puro, leitor GET Stripe TEST e testes unitários; não existe ainda CLI, operação orquestrada Stripe, migration, ledger, integração PostgreSQL/RLS ou teste E2E de conta sandbox. A versão exigida de schema permanece **78**. O PR #7 continua draft.

## Decisão

A Stripe documenta o filtro `GET /v1/balance_transactions?payout=po_...` **apenas para payouts automáticos**. A sua utilização exige obter o payout diretamente no fornecedor com chave TEST, observar `automatic=true`, `reconciliation_status=completed` e recolher uma lista completa via paginação limitada. Os IDs de transação esperados têm de vir da validação segura de Charges de ADR-120, nunca do browser, metadata ou operador. Payout manual, falha, estados incompletos, divergência de moeda/source/net, lista truncada ou Charge ausente não demonstram atribuição: devolver deferred/rejected.

O módulo `stripe-test-payout-observation.ts` concretiza somente a decisão determinística **offline**, sem acesso à rede ou à BD. Aceita um objeto Stripe TEST verificado e uma lista já carregada e limitada; a futura camada privilegiada tem de provar origem, integridade, paginação e tenant antes de o invocar. Outros movimentos de conta podem coexistir num payout; por isso nem o somatório das Charges de uma invoice tem de coincidir com o montante total do payout.

Mesmo quando a Stripe comunica `paid` e `completed`, isto não é comprovativo bancário definitivo e pode haver reversões/falhas posteriores. `settlementVerified=false`, `billable=false`, `billingVerified=false`, `automationEnabled=false` e `billing_entitlement_activation_gate.enabled=false` mantêm-se obrigatórios. Sem novas permissões, pagamentos, deploy, merge ou alteração comercial.

## Próximo incremento da mesma ADR

Revalidar a cadeia Checkout→subscription→invoice→group→Charge→balance transaction; provar pertença do payout à mesma conta Stripe; ledger append-only com FORCE RLS/grants mínimos e auditoria, testes de integração PostgreSQL, scripts manuais opt-in e CI completo no SHA final. Sem atribuição cross-tenant e sem extrapolação de disponibilidade para liquidação.

## CI

O primeiro commit da ADR-121 falhou no gate Prettier (backend), enquanto Flutter e Compose passaram. O incremento corretivo mantém `prettier-ignore` circunscrito às funções/fixtures densas desta observação, seguindo o precedente do parser ADR-120; não altera o contrato de segurança. Validar resultado do CI do commit corretivo antes de declarar aprovação.
