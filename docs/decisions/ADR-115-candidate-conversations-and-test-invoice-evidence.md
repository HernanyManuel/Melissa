# ADR-115 — Definição candidata de conversa e evidência Stripe TEST de fatura paga

## Estado

Implementação na branch `feature/phase-8-inbox`, PR #7 draft, schema **73**. Validar CI no HEAD final. Sem cobrança live, enforcement, merge, deploy ou novas funcionalidades pagas.

## Contexto

As ADRs 113–114 impõem `allowed=false` e `billingVerified=false`, observam tokens técnicos por execução e proíbem transformar resultados Stripe `active` em autorização comercial. Para avançar na medição há duas dúvidas independentes: (i) qual evento constitui uma *conversa faturável*? e (ii) o que constitui prova de uma obrigação faturada e efetivamente liquidada?

## Decisão A — Métrica candidata, não contratual

O `GET /api/v1/tenants/:tenantId/billing/usage` passa a apresentar `conversationCandidate` com definição explícita `distinct_completed_ai_turn_conversations_30d`: **número de conversas distintas** com pelo menos um `ai_usage_events.outcome='completed'` nos últimos 30 dias corridos, unido ao `conversation_id` do `ai_turns`, consultado dentro da RLS do tenant. Replays de turn e múltiplos turns da mesma conversa contam uma vez na mesma janela.

**Não corresponde a unidades cobradas.** Uma conversa pode atravessar períodos comerciais; conversas humanas, handoffs, falhas e mensagens ficam de fora. Ainda faltam decisão de produto sobre janela de atividade, início/fim da conversa faturável, renovação, deduplicação cross-channel e semântica de overage. Esta métrica tem `commercialPolicy='draft_only'` e `billable=false`; não tem quota nem preço associado. O ledger de tokens da ADR-114 permanece imutável e não faturável.

## Decisão B — Evidência limitada de estado invoice Stripe TEST

A migration 73 cria `stripe_test_invoice_evidence` (append-only, `invoice_id` único), ligada à subscrição tenant por FK composta e ao evento já assinado do inbox. A base exige `status='paid'`, `billable=false`, `entitlement_verified=false`, montante positivo e currency ISO. A API runtime não pode inserir, alterar ou apagar evidência, nem ler invoice ID, customer, subscription ou valores monetários. FORCE RLS protege a leitura mínima permitida.

O operador em ambiente **exclusivamente de teste** pode optar por `pnpm --filter @melissa/backend stripe:invoice-evidence-test evt_...`, com `NODE_ENV=test`, `STRIPE_TEST_INVOICE_EVIDENCE_ENABLED=true`, `STRIPE_TEST_SECRET_KEY=sk_test_...` e `BILLING_INVOICE_VERIFIER_DATABASE_URL`. O papel `melissa_billing_invoice_verifier` inicia em `NOLOGIN` e necessita provisionamento manual `infra/scripts/billing-invoice-verifier-login.sql`, numa base de teste descartável. Não tem permissões para criar tenants, clientes, sessões Checkout, assinaturas nem alterar preços/planos.

Do webhook `invoice.paid` previamente assinado retira-se **somente o ID da invoice**. O backend faz `GET /v1/invoices/:id` no host Stripe fixo, com timeouts de 5 s, resposta até 128 KiB, API version pin, sem redirects e chave test. Exige `livemode=false`, `status=paid`, `paid=true`, `paid_out_of_band=false`, `collection_method=charge_automatically`, `amount_paid>0`, `amount_paid=total`, `amount_remaining=0`, timestamp pago e parent subscription. Um segundo GET à subscription confirma o customer/subscription/price atuais, com exatamente um item.

A identidade comercial **não provém de metadata** do evento/invoice: é resolvida exclusivamente por subscription Stripe já conhecida, checkout intent `ready` e plano ativo com a mesma currency e price. A decisão é revalidada dentro de transação protegida por lock de invoice, com UNIQUE invoice ID e FK tenant/subscription. Repetição idêntica regista `replayed`, mudanças de identificação/montante são recusadas, falhas do fornecedor são `deferred`, e todas as decisões geram `stripe_invoice_evidence_attempts` append-only com motivo sanitizado. O SQL RLS também exige que o invoice ID do evento assinado corresponda à observação persistida.

**Limite financeiro essencial:** `invoice.paid` indica o *estado observado* da fatura, não comprova de forma definitiva a liquidação financeira, ausência de chargebacks/refunds, cobertura do período, impostos, pro-rata, nem direito ao serviço. O Stripe sandbox real ainda não foi executado. A evidência **não** alimenta `billing_entitlement_activation_gate`, não habilita `automationEnabled`, não altera `billingVerified`, não gera invoices nem cobranças, e não é integrada automaticamente no dispatcher da ADR-111. Mesmo a presença de um snapshot pago é insuficiente para desbloquear a aplicação.

## Verificação e limites

Testes unitários de parser/provider recusam invoices live, não pagas, sem subscription parent, out-of-band, montante nulo, status errado, custo divergente e host/credenciais maliciosos. Integração PostgreSQL real com role restrito e provider simulado verifica associação de tenant, metadata estrangeira, unicidade/replay, desvio de currency/customer/price, falha temporária, auditoria, imutabilidade, FORCE RLS, grants e leitura mínima runtime; o endpoint de uso valida a nova métrica candidata.

Antes de implementar uma unidade faturável, reserva de quota ou autorização paga é necessário: aprovação formal do evento de conversa comercial, ledger de períodos, verificação de transações/reembolsos, faturas Stripe sandbox reais, reconciliação de disputas/créditos e testagem E2E, com alteração futura deliberada da trava deny-only da ADR-113.
