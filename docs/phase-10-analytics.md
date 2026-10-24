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
