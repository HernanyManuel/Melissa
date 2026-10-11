# ADR-093 — Triagem por estado de conversa no inbox

## Estado

Fatia incremental validada da Phase 8, ainda no PR draft #7. Nenhum merge, deploy, envio WhatsApp live ou alteração de credenciais.

## Contexto

A API de listagem já suporta pesquisa literal, etiqueta, atribuição por colaborador e filtro de mensagens não lidas por operador (ADR-090 a ADR-092). O estado persistente `conversations.status` indica, entre outros, `open`, `closed` e `archived`. A equipa necessita separar conversas abertas das encerradas sem perder o isolamento tenant/ator nem introduzir erros de paginação.

## Decisão

- `GET /api/v1/tenants/:tenantId/conversations` aceita um novo parâmetro opcional `status=all|open|closed`, validado pelo DTO. `all` (ou a omissão) mantém o comportamento anterior, incluindo possíveis conversas arquivadas; `open` e `closed` selecionam **apenas** a correspondência exata no campo `status`. Valor desconhecido: HTTP 400.
- A filtragem é feita no PostgreSQL **antes** do `LIMIT 51` em ambas as modalidades: Prisma padrão e a consulta SQL do filtro `unreadOnly=true`. Mantém-se paginação ordenada por ID com até 50 elementos, `next` e contagem de não lidas isolada por ator. Não se filtram apenas as 50 linhas já paginadas.
- Ao usar `after`, o cursor tem de apontar para uma conversa do tenant e do estado selecionado, bem como respeitar as restrições de etiqueta que já existiam. Cursor de outro estado, ou de outro tenant, não é aceite (HTTP 404). O cliente deve conservar todos os filtros no pedido de página seguinte e reiniciar o cursor quando mudar de filtro.
- No Flutter existe um menu compacto com as opções «Todos os estados», «Abertas» e «Encerradas», traduzidas para pt/en/es/fr/it/de. O menu ativo usa um ícone distinto para reduzir a altura ocupada em ecrãs estreitos. A seleção é reiniciada ao trocar de tenant ou após revogação de acesso.
- O refresh desencadeado por SSE preserva `status` e compara-o com o filtro em vigor antes de aplicar uma resposta atrasada, evitando misturar instantâneos de filtros diferentes.

## Segurança e verificação

A autorização continua a exigir `messages:read`, sob a transação de tenant e RLS existentes. Não são devolvidas credenciais nem conteúdos adicionais. Não existe novo endpoint de escrita ou migração.

Testes HTTP/integrados verificam combinação com etiqueta, `unreadOnly=true` e mudança efetiva para `closed`, rejeição de valores inválidos, impossibilidade de usar cursor de estado incompatível e isolamento entre tenants. Teste Flutter verifica combinação com atribuição, `after` nas páginas subsequentes e reposição da paginação quando o estado muda.

**CI funcional:** [38139479035](https://github.com/HernanyManuel/Melissa/actions/runs/38139479035): backend (formatação, tipos, integração PostgreSQL/RLS e worker), Flutter (analyze, testes, build web) e Docker Compose concluídos com sucesso.

## Limites

Não há campo de estado independente para prioridade nem automatismo de reabertura; filtrar não altera a conversa. Conversas `archived` podem permanecer visíveis em «Todos os estados», mas não nas opções «Abertas» ou «Encerradas». Não existe total global fora das linhas carregadas nem subscrição push externa. Não há validação E2E com credenciais reais da Meta, merge ou deploy.
