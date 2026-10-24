# ADR-121 — Protocolo de validação supervisionada Stripe TEST

## Âmbito e condições de segurança

Este protocolo é um **guia**, não prova de que a validação externa tenha sido executada.
O CI [#40141835199](https://github.com/HernanyManuel/Melissa/actions/runs/40141835199) do commit `3dce3b6` validou backend/Flutter/Compose, PostgreSQL com provider Stripe **simulado**, controlos RLS e auditoria de dependências de produção. Os testes incluem rejeição de redirecionamentos HTTP, payloads acima de 128 KiB e respostas não JSON, mas não substituem uma chamada autorizada à Stripe TEST real. **Isto não é um ensaio contra a API Stripe TEST real.** Antes de testar numa conta Stripe, obter aprovação do operador para usar apenas uma conta **TEST** isolada. Não ativar Checkout comercial, cobranças LIVE, direitos pagos, deploy nem merge.

Pré-requisitos: schema 79 aplicado apenas numa BD de teste; papel `melissa_billing_invoice_verifier` com credenciais independentes, sem superuser/BYPASSRLS; ligação `BILLING_INVOICE_VERIFIER_DATABASE_URL` sem acesso pelo runtime; chave `sk_test_` guardada fora de logs e ficheiros versionados; invoices de grupos com 2–8 pagamentos efetivos no ambiente TEST; payouts **automáticos** de TEST disponíveis (não assumir que a conta os suporta). Nunca copiar dados de clientes ou de produção.

## Procedimento sugerido para operador autorizado

1. Confirmar que o commit testado tem CI verde e que a BD está no schema 79. Documentar SHA, ambiente, operador e janela de observação **sem** gravar secrets.
2. Confirmar a cadeia de dados de teste pré-existente: Checkout → subscription → invoice → InvoicePayments → PaymentIntents → Charges. Executar os verificadores de grupos/risco/saldo anteriores com o mesmo papel segregado, usando apenas IDs `in_` TEST associados ao tenant autorizado.
3. Ler através da API Stripe **TEST** o payout `po_`, confirmar `livemode=false` e `automatic=true`, `status=paid`, `reconciliation_status=completed`. Se qualquer propriedade não existir, não for fiável ou não corresponder à API da conta, **parar e registar incompatibilidade**; não sintetizar valores.
4. Em ambiente TEST e numa shell sem registo de segredos, definir `NODE_ENV=test`, `STRIPE_TEST_PAYOUT_ENABLED=true`, `STRIPE_TEST_SECRET_KEY` e `BILLING_INVOICE_VERIFIER_DATABASE_URL`. Executar **manualmente** `pnpm --filter @melissa/backend stripe:payout-test in_... po_...`. O comando faz apenas GET na Stripe; a observação fica no ledger local com flags financeiras bloqueadas.
5. Confirmar o resultado `recorded` ou `replayed`, consultar as tabelas de observação e auditoria através de um operador autorizado, e verificar que `payout_verified`, `settlement_verified`, `financial_clearance` e `billable` permanecem **FALSE**. Repetir para confirmar replay; testar manual/mismatch/partial sem fabricar associação nem ultrapassar paginação.
6. Sanitizar IDs de conta, hashes de transações, respostas Stripe e qualquer PII em relatórios partilhados. Não registar chave Stripe, URL com password ou payload bruto na documentação.

## Critérios de paragem (fail closed)

- Payout manual, `failed`, `pending`, `in_transit` ou sem reconciliação completada.
- Lista truncada, paginação excedida, transaction ID repetido ou Charge do grupo em falta.
- Divergência invoice/tenant/subscription, moeda, source, fee/net, Checkout, preço ou estado de Charge.
- Falha de acesso restrito ao PostgreSQL, tentativa de alterar linha imutável ou flags financeiras a TRUE.
- Ausência de payouts automáticos na conta: registar **não aplicável / não executado**, sem marcar o E2E como aprovado.

## Evidência mínima do ensaio

Registar somente commit e versão de schema, versão de API Stripe, modalidade de payout, datas TEST, resultado censurado do comando, número de transações esperadas/observadas, digest não sensível, resultado de replay e permissões PostgreSQL conferidas. Nunca inferir transferência bancária irrevogável a partir de `paid`.

## Pendências

Execução real em conta Stripe TEST com payouts automáticos e confirmação do comportamento efetivo da API; revisão de gestão de segredos e credenciais segregadas; política financeira e autorização explícita de rollout separadas. O PR #7 deve permanecer draft. `billing_entitlement_activation_gate.enabled=false`.

## Registo operacional de ensaio (sem segredos)

Preencher uma cópia **fora do repositório** e publicar apenas a versão redigida. Este modelo não constitui prova de execução.

| Campo | Valor a registar |
| --- | --- |
| Commit/CI | SHA exato e URL do CI verde do commit ensaiado |
| Ambiente | BD TEST isolada, schema 79; sem dados LIVE |
| Autorização | Aprovação do operador e janela de execução |
| Credenciais | Apenas confirmação de chave TEST e role segregada; **nunca** segredos |
| Stripe | Versão da API TEST e existência de payout automático |
| IDs | Referências de invoice e payout redigidas |
| Cadeia | Contagem de Charges (2–8), moeda e líquido agregado TEST |
| Execução | recorded / replayed / deferred / rejected / não executado |
| Replay | Resultado redigido e ausência de duplicação no ledger |
| RLS | Role sem BYPASSRLS, ledger append-only |
| Flags | payout_verified=false; settlement_verified=false; financial_clearance=false; billable=false |
| Resultado | E2E TEST confirmado **só** com evidência Stripe real, ou pendente |

### Decisão de não avançar

Marcar **não aprovado / pendente** se não existir payout automático na conta TEST, se a segregação de privilégios não estiver comprovada, se a paginação permanecer incompleta, se o ID do payout divergir ou se não for possível verificar todas as flags financeiras bloqueadas. Este relatório nunca autoriza rollout, entitlement, merge ou deploy.
