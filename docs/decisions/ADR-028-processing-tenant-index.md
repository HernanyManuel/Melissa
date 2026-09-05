# ADR-028 — Índice da consulta de processamento por tenant

Estado: schema 15, incremento de infraestrutura da Phase 4.

## Decisão

Adicionar B-tree inbound_dispatch_tenant_state_id_idx sobre (tenant_id, state, id). A API filtra igualdade de tenant/estado, aplica intervalo id > cursor e ordena por id. O índice disponibiliza um caminho compatível com essa consulta, sem depender de percorrer o backlog global. Não força decisões do planner.

Preservar o índice global inbound_dispatch_due_idx, utilizado pelo worker para descobrir trabalho devido. Sem alterar políticas RLS, grants, query, paginação, conteúdo ou estados. Readiness passa a exigir schema 15.

## Rollout

A migration transacional cria o índice e atualiza a versão atomicamente. lock_timeout de 5 segundos e statement_timeout de 60 segundos limitam espera e execução. O projeto permanece pré-produção; este CREATE INDEX pode bloquear escritas enquanto constrói o índice.

Antes de aplicar a uma tabela live grande, medir tamanho/carga, ensaiar em staging e preparar rollout concorrente revisto separadamente. Não executar automaticamente contra produção. Se falhar por timeout, a transação não promove a versão; investigar bloqueios e o registo de migration falhada antes de uma nova execução. Não remover dados para resolver o erro.

O gate de versão é exato: API/worker antigos esperam 14 e deixam de estar ready após schema 15. Atualizar schema e binários em janela coordenada; não prometer rolling deploy sem indisponibilidade. Um rollback de binário exige também rever esse gate; o índice adicional, por si só, é compatível com a query antiga.

## Verificação e limites

Teste de catálogo confirma B-tree válido/pronto, colunas e ordem exatas, ausência de predicado parcial e preservação do índice global. As regressões HTTP verificam paginação e isolamento com o schema migrado. CI gera Prisma, migra, testa backend/worker/Flutter e Compose.

Não é benchmark nem prova de desempenho para 10.000 tenants. EXPLAIN ANALYZE com distribuição/volume representativos e testes de carga continuam pendentes. Sem alteração de UI, reenvio, merge ou deploy.
