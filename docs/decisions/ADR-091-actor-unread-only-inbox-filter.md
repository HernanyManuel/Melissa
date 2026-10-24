# ADR-091 — Filtragem «Só não lidas» por operador antes da paginação

## Estado

Implementado como melhoria incremental da Phase 8, na branch `feature/phase-8-inbox`, em PR draft. Sem merge, deploy ou ativação do WhatsApp live.

## Contexto

A ADR-085 introduziu cursores de leitura monotónicos por tenant/operador e contadores `unreadCount` baseados apenas em eventos duráveis de entrada `message.received`. A ADR-090 permitiu pesquisar e filtrar conversas por etiqueta. Filtrar somente no Flutter as 50 conversas já recebidas não é correto: uma lista cheia de conversas lidas pode esconder todas as conversas ainda não lidas nas páginas seguintes.

## Decisão

- `GET /tenants/:tenantId/conversations` aceita `unreadOnly=true` (ou `false`). Outros valores, incluindo `1` e `TRUE`, devolvem 400. O valor omitido ou `false` conserva o comportamento anterior.
- Para `true`, o backend seleciona IDs **antes de `LIMIT 51`**, com `EXISTS` sobre `inbox_events` e um evento `message.received` com sequência superior ao `last_read_sequence` do **ator autenticado**. O filtro é aplicado na transação tenant-scoped autorizada para `messages:read`; não recebe `actorId` do cliente.
- A consulta SQL parametrizada combina, na base de dados, o cursor UUID `after`, o filtro de etiqueta do tenant `tagId`, pesquisa literal escapada `q` e a condição de não lida. Ordena IDs em ordem ascendente e devolve até 51 candidatos; os dados das primeiras 50 conversas são obtidos pelo Prisma com a mesma projeção da listagem normal. As contagens e `unreadUpTo` são calculados somente para as conversas devolvidas. O cursor de paginação `next` permanece o ID do último item visível.
- O cursor `after` continua validado no tenant e na etiqueta selecionada, mas não exige que a conversa permaneça não lida. Assim, uma confirmação de leitura entre pedidos não invalida indevidamente o cursor. Como a leitura e a entrada de mensagens podem alterar o conjunto, a paginação é uma vista dinâmica, não um snapshot congelado.
- O Flutter apresenta o `FilterChip` «Só não lidas», localizado em pt/en/es/fr/it/de; ao mudar o filtro reinicia paginação, seleção e alertas transitórios. O parâmetro é preservado nas páginas seguintes, na pesquisa, no filtro por etiqueta e nos refreshes por SSE. Depois de um recibo de leitura válido da conversa selecionada, a linha é removida localmente da lista filtrada sem inferir novas mensagens ou efetuar envios.
- Não há migração nova, novas permissões, alteração ao worker, efeitos externos nem acesso a texto de mensagens para calcular o filtro.

## Verificações

[Workflow funcional 38033475606](https://github.com/HernanyManuel/Melissa/actions/runs/38033475606) **integralmente verde**, com backend (format/lint/typecheck, testes PostgreSQL/RLS, integração com worker e OpenAPI), Flutter (analyze, tests e build web) e Docker Compose.

O teste de integração cobre `unreadOnly=true/false`, valores inválidos, isolamento entre atores com cursores distintos, permissão `viewer`, composição com `q` e `tagId`, exclusão de conversas sem eventos por ler, leitura explícita e uma sequência de **51 conversas já lidas** com IDs anteriores à conversa não lida. O teste Flutter cobre a persistência de `unreadOnly` com pesquisa, etiqueta e cursor, e a reposição do cursor quando o filtro é desligado.

## Limites

- As não lidas representam **eventos de entrada não confirmados pelo operador**, e não garantia de não visualização nem prioridade de atendimento. Não há filtragem por atribuição de staff e não existe contagem global independente da paginação.
- Alterações concorrentes de leitura, evento ou etiqueta entre páginas podem reordenar a presença de conversas. O filtro mantém isolamento RLS e um cursor validado, mas não proporciona snapshot temporal único.
- As notificações in-app existentes continuam voláteis; não há push, sons, notificações browser ou WhatsApp live ativados. O PR continua por rever antes de qualquer merge/deploy.
