# ADR-098 — Triagem de conversas por ligação específica do canal

## Estado

Implementação incremental no PR draft #7 (branch `feature/phase-8-inbox`), validada integralmente no [workflow #38213970910](https://github.com/HernanyManuel/Melissa/actions/runs/38213970910), commit `2c226ee6dec7c6a6f6e3230e0aff7b11334330b5`. Não autoriza merge, deploy, credenciais reais ou ativação live.

## Contexto

O filtro de `channelMode=mock|live` da ADR-097 distingue apenas tipos operacionais de ligação. Dentro do mesmo tenant, múltiplos números ou canais live e mock podem coexistir. Os operadores com `messages:read` precisam de consultar conversas de uma ligação concreta, sem depender de `channels:manage`, que é uma permissão administrativa. O filtro deve respeitar os cursores, a via de não lidas por ator e o replay SSE durável.

## Decisão

1. Acrescentar `channelId` opcional (UUID) à consulta de conversas. Antes de qualquer paginação, confirmar que a ligação existe sob `TenantService.scoped(actor, tenantId, 'messages:read', ...)`; UUID inválido dá 400 e ligação fora do tenant dá 404. Não aceitar `actorId` nem provider IDs fornecidos pelo cliente.
2. Na via Prisma, `channelConnectionId` é igualdade exata. Na via `unreadOnly=true`, SQL parametrizado usa `c.channel_connection_id=<uuid>` na mesma transação tenant/RLS, antes de `ORDER BY c.id LIMIT 51`. Validar o `after` contra `tenantId`, `channelId`, modo, estado e etiqueta; cursor de ligação diferente é 404. Pesquisa, atribuição e contagens por operador mantêm as regras existentes.
3. Criar `GET /inbox/channel-options?after=<uuid>` com a mesma permissão de leitura: catálogo com apenas `id`, `displayName` e `mode` de ligações com pelo menos uma conversa do tenant. Ordenado por `id ASC`, 50 registos por página e `next` calculado com 51 linhas; cursor da mesma coleção obrigatório. Não expor credenciais, external IDs, `metadata`, secret references, flags de envio, consentimento ou estados de entrega. `GET /channels` mantém RBAC `channels:manage` independente.
4. No Flutter, catálogo apenas por consulta REST autorizada quando abre o painel; «Carregar mais ligações» sem lista ilimitada, erro e retry sem enviar nada; reset por tenant e callbacks geracionais. Conservar `channelId` nas páginas e em refreshes SSE, invalidando o resultado quando filtros mudam. Seleção explícita reinicia a paginação; nunca marca mensagens como lidas.
5. Não há alteração ao controlo humano, envio manual, intents, `mode_epoch`, fila/outbox, checkpoint SSE, RLS/migrations ou schema (62).

## Verificação final

O CI funcional passou PostgreSQL/RLS e integração HTTP com worker separado, suite de unitários, recuperação worker/Redis, OpenAPI, audit de produção, Flutter analyze/test/build Web e Compose readiness. Foram corrigidas fixtures preexistentes sensíveis à ordem dos testes: estado WhatsApp com cliente próprio e descoberta de dispatch de calendário sem pressupor ausência de outros tenants. O seletor Flutter utiliza ícone compacto para preservar layouts estreitos. Nenhuma destas correções altera schemas, integrações live ou envios.

## Testes e limites

A integração HTTP verifica 400/404, isolamento de ator/tenant, dois modos de ligação, combinação com `channelMode`, `status` e `unreadOnly`, cursor incompatível, projeção mínima de catálogo, RBAC viewer e paginação com 60 ligações. Widget tests cobrem filtro com paginação, composição com outras condições, paginação do catálogo e descarte de consulta tardia do tenant anterior.

O filtro baseia-se na ligação **atual** e não garante que o provider esteja disponível. A listagem só mostra ligações com conversas. Não se promete snapshot das páginas perante escritas concorrentes, notificações push nem E2E Meta live.
