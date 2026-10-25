# Phase 10 — Analytics e operações: arranque controlado

## Base e isolamento

Esta branch deriva de `feature/phase-8-inbox`, que contém a Phase 9/ADR-121 ainda em PR #7 draft. Não implica aceitação, merge ou deploy da fase anterior. A fase P10 do [plano](../IMPLEMENTATION_PLAN.md) abrange métricas agregadas, dashboard, custos, administração, auditoria operacional, suporte e jobs falhados. Este documento define o primeiro contrato de trabalho; **nenhum endpoint novo nem dashboard estão implementados por este commit**.

## Primeiro incremento — diagnóstico read-only tenant-scoped

- Expor, depois de inventariar as tabelas e permissões existentes, **métricas técnicas observadas**, nunca receita faturada inferida de eventos simulados: volumes de conversas/turns, resultados dos jobs e consumo técnico, com período e timezone explícitos.
- Autorizar leitura com papel e tenant verificados no servidor, RLS forçada e sem usar filtros de tenant fornecidos pelo cliente como autoridade. Não agregar nem revelar IDs, eventos, mensagens ou custos individuais entre tenants.
- Separar explicitamente contagens técnicas, estimativas de custo e dinheiro reconciliado. Não apresentar MRR, ARR, churn, lucro ou cobrança sem contratos comerciais e fontes reconciliadas verificadas.
- Paginar leituras detalhadas; aplicar janelas máximas e limites determinísticos a agregações; evitar queries sem limite, full scans não controlados e exposição de PII nos logs.
- Não conceder acesso de suporte implícito por ser administrador global: acesso temporário, justificado e auditado exige desenho e aprovação separados.
- Falha de dados, inconsistência de moeda, reconciliação ou ausência de entitlement financeiro devem produzir estado indisponível/não determinado, **nunca** uma métrica financeira aparentemente confirmada.

## Critérios de aceitação do primeiro endpoint

1. Inventário das fontes reais e decisões de unidade/período/retention descritas num ADR próprio; só depois definir rota, formato e migrations indispensáveis.
2. Testes PostgreSQL/RLS com tenants A/B, utilizador sem membership, papel sem permissão e contexto vazio; isolamento comprovado mesmo em erro e replay.
3. Respostas determinísticas para períodos vazios, timezone, contagens e paginação, com deduplicação dos eventos à origem.
4. Testes de concorrência/worker e limites; Flutter apenas depois de contrato backend verificado.
5. CI backend, Flutter e Compose verde no commit exato; PR próprio em draft, sem merge/deploy.
6. `billing_entitlement_activation_gate.enabled=false`, `billable=false` e as flags de liquidação da ADR-121 permanecem inalteradas. Não consultar Stripe LIVE.

## Gate operacional ainda pendente

ADR-121 exige o ensaio E2E supervisionado numa conta Stripe TEST real, com payout automático, operador autorizado e credenciais segregadas. Esta fase pode iniciar desenvolvimento técnico **sem converter esse gate pendente em aprovação**. O PR #7 permanece independente e em draft.

## Inventário inicial de fontes existentes (verificado no código)

| Fonte | Campos ou garantias já presentes | Uso P10 proposto | Limite |
| --- | --- | --- | --- |
| `conversations` | `tenant_id`, `opened_at`, `closed_at`, `status`, `mode`, `last_message_at` | Contagens técnicas de conversas por janela | Abertura não é conversa faturável nem sucesso da automação |
| `ai_turns` | `tenant_id`, `conversation_id`, `status`, `started_at`, `completed_at`, `failure_code` | Turnos iniciados/terminados e falhas por janela | Evitar duplicar ao juntar mensagens ou eventos |
| `ai_usage_events` | Chave única `(tenant_id,turn_id)`, tokens, `cost_micros` opcional, `currency` opcional, preço observado | Diagnóstico técnico de tokens e custo **estimado** | Valores nulos e moedas distintas não podem ser somados indiscriminadamente |
| `billing_usage_observations` | Observações imutáveis, fonte atual do relatório billing de 30 dias | Referência para deduplicação e confronto das contagens | `billable=false`; não confirma obrigação de pagar |
| `audit_events` | `tenant_id`, `actor_id`, `actor_type`, `action`, `created_at` | Contagens operacionais por tipo de ação | Nunca publicar detalhes pessoais ou acesso implícito a suporte |

O serviço já existente `BillingUsageService.report`, exposto em `GET /api/v1/tenants/:tenantId/billing/usage`, usa `TenantService.scoped(actor, tenantId, 'billing:read', ...)` e uma janela móvel UTC de 30×24 horas. Agrega contagens e tokens como strings de inteiros exatos; `conversationCandidate` é **draft_only**. A P10 deve reutilizar estas garantias, não criar contagens paralelas com semânticas divergentes.

**Primeira decisão de engenharia:** antes de escrever uma nova query, definir se o dashboard precisa de janelas móveis ou dias de calendário na timezone da empresa; como `started_at`, `completed_at` e `observed_at` têm semânticas diferentes, cada métrica deve identificar explicitamente a coluna temporal de origem. Os custos nulos ficam `unavailable`, nunca zero; só se somam custos com mesma moeda e escala, sem converter USD/EUR implicitamente.

**Próximo incremento executável:** ADR P10 com contrato de métricas técnicas agregadas, endpoint read-only separado de billing, testes A/B de autorização e consistência temporal, seguindo-se interface Flutter apenas após CI verde. Este inventário não valida execução E2E nem altera esquemas ou operações.

## Implementação técnica atual — PR #10 (draft)

O endpoint `GET /api/v1/tenants/:tenantId/analytics/summary` é exclusivamente de leitura e usa `TenantService.scoped(actor, tenantId, 'audit:read', ...)`, com RLS e autorização por tenant. A janela é móvel, `[from,to)`, com duração fixa de 30×24 horas UTC, e não corresponde a meses civis ou aos dias locais do tenant.

| Campo | Fonte e instante contado | Interpretação |
| --- | --- | --- |
| `conversationsOpened` | `conversations.opened_at` | Conversas abertas na janela |
| `aiTurnsStarted` | `ai_turns.started_at` | Turnos iniciados na janela, independentemente do desfecho |
| `aiTurnsCompleted` | `ai_turns.started_at`, `status='completed'` | Turnos iniciados na janela cujo estado atual é concluído |
| `aiTurnsFailed` | `ai_turns.started_at`, `status='failed'` | Turnos iniciados na janela cujo estado atual é falhado |
| `aiTurnsRunning` | `ai_turns.started_at`, `status='running'` | Turnos iniciados na janela ainda em execução |
| `auditEvents` | `audit_events.created_at` | Contagem de eventos, sem expor identidades nem conteúdo |

As contagens são strings decimais inteiras. Os desfechos dos turnos representam **estado atual para turnos iniciados na janela**, não o número de conclusões/falhas ocorridas durante o período, nem uma partição necessariamente exaustiva de todos os estados de turno. O `period` devolvido é calculado no servidor. Este endpoint não retorna tokens, custo, receita, MRR, entitlement ou liquidação verificada. `financialStatus='not_defined'`, `billable=false` e `entitlementGranted=false` são invariantes.

A integração PostgreSQL valida 401 sem autenticação, 403 para papel sem `audit:read`, 404 para acesso ao tenant errado, rejeição de POST, isolamento A/B, turnos em execução e falhados, e corte de conversas aos 29/31/45 dias. Estes são testes do endpoint técnico, não uma prova de Stripe TEST E2E, nem de disponibilidade de dados financeiros.

**Estado:** schema 79; PR #10 draft empilhado sobre PR #7 draft; sem merge, deploy, Stripe LIVE nem ativação comercial. O gate externo de payout Stripe TEST da ADR-121 permanece pendente. Os critérios acima referentes a ADR próprio, concorrência e interface Flutter são objetivos de fase, não devem ser inferidos como todos concluídos por este primeiro endpoint.
