# ADR-114 — Ledger imutável de observações técnicas da IA, sem faturação

## Estado

Implementado na branch `feature/phase-8-inbox`, PR #7 draft, schema **72**. Verificar CI do HEAD final. Esta ADR **não** define conversas faturáveis, invoices, montantes a pagar, entitlements, quotas transacionais ou pagamentos reais.

## Contexto

A ADR-113 introduziu uma política deny-only de entitlements e diagnóstico informativo de staff/canais. A plataforma já grava `ai_usage_events` na mesma transação em que conclui uma execução de IA; `(tenant_id,turn_id)` é único e o source mantém `outcome`, tokens e eventual snapshot do **custo técnico do modelo** (ADR-060/AI pricing). Nada disso é a unidade comercial de conversa, nem evidencia um pagamento, nem autoriza cobrança.

## Decisão

1. A migration 72 cria `billing_usage_observations` por tenant, usando `(tenant_id,source_event_id)` como chave primária, unicidade adicional `(tenant_id,turn_id)` e FKs compostas ao source `ai_usage_events` e à execução `ai_turns`. Apenas captura: resultado técnico do turn, número de tokens de entrada/saída, timestamp original e timestamp de registo. `billable=FALSE` é uma CHECK PostgreSQL imutável nesta versão. Não existe coluna de preço comercial, moeda cobrada, invoice, VAT, dívida ou uso contratual.
2. Um trigger `AFTER INSERT` no `ai_usage_events`, `SECURITY DEFINER`, `search_path=pg_catalog` e referência explícita `public.billing_usage_observations` regista a observação **na mesma transação do source**. Se a escrita não for possível, a inserção no source também falha. O trigger não interpreta mensagens, Stripe, planos nem metadados de tenant. Existing source rows são backfilled na migration, sem alteração de resultado comercial.
3. O ledger impõe `FORCE ROW LEVEL SECURITY`, política SELECT por `app.tenant_id` e grants mínimos de **SELECT por coluna** para `melissa_runtime`. A API não tem INSERT, UPDATE ou DELETE. Um trigger `BEFORE UPDATE OR DELETE` recusa alterações inclusive de um cliente privilegiado comum, até uma migration de governança. Um utilizador fora do tenant não consegue ler observações.
4. O endpoint `GET /api/v1/tenants/:tenantId/billing/usage` exige AuthGuard e `billing:read` via `TenantService.scoped`: apenas proprietário/administrador. A consulta agregada PostgreSQL percorre **os últimos 30 dias corridos**, filtrados por tenant, incluindo conclusão/handoff/falha/stale quando presentes, e soma eventos/tokens por outcome. Todos os totais são convertidos em **strings decimais exatas**, sem truncamento de inteiros JavaScript. Inclui `window.from/to/days=30`, `billable=false`, `financialStatus=not_defined` e `entitlementGranted=false`.
5. O HTTP não permite impor período, alterar total, criar evento, marcar faturável, inserir preço ou escolher fontes de utilização. Não expõe provider/model, customer, conversation, turn ou source IDs. Eventos com mais de 30 dias permanecem auditáveis em BD mas não entram na resposta de janela recente.
6. Reprocessamento concorrente do mesmo turn não duplica uso: a constraint original em `ai_usage_events` e a unicidade do novo ledger impõem o isolamento. Uma gravação falhada não pode deixar evento de faturação isolado. O estado pago continua bloqueado em `billing_entitlement_activation_gate.enabled=false` (ADR-113).

## Testes e riscos restantes

Integração PostgreSQL real/Nest verifica autenticação, owner/admin, negação a viewer/tenant estrangeiro, RLS unscoped, totais independentes, retenção de observação histórica fora da janela, dois INSERT concorrentes sobre o mesmo turn, FK source, append-only, grants mínimos e ausência de dados Stripe/preços no JSON. O CI do HEAD final é a prova automatizada.

**Limites:** este ledger descreve *tokens da execução de IA*, não uma conversa faturável. Não cobre mensagens humanas, canais, reservas, overages, refunds nem períodos contratuais. O timestamp do source foi mantido; não se assume que 30 dias corridos coincidem com a renovação de uma subscrição. Para futura cobrança são necessárias: definição de unidade comercial, fonte verificável de invoice/settlement Stripe, snapshot de período, ledger de ajustes e reversões, deduplicação/atomicidade do contador comercial, estratégia trial/grace, orçamento e E2E no sandbox. A conversão em direito comercial exige uma nova migration e revisão de segurança independente. Nenhuma cobrança live, deploy ou merge foi autorizado.
