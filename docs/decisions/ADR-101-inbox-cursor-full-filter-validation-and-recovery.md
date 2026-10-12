# ADR-101 — Validação completa do cursor e recuperação de páginas expiradas no inbox

## Estado

Implementação na `feature/phase-8-inbox`, PR #7 draft. CI final a confirmar; sem merge, deploy ou integrações live.

## Contexto

As ADR-097 a ADR-100 acrescentaram filtros de canal, estado, controlo e ordenação recente, preservando um cursor opaco `after` por UUID. A verificação original rejeitava cursores de outro tenant, status, canal e etiqueta, mas não avaliava `assignment`, pesquisa por nome `q` nem estado de não lidas por operador. Assim, um cursor de outra lista, ou uma conversa atribuída ou marcada como lida entretanto, podia continuar a ser usado como âncora. O Flutter descartava toda a listagem em qualquer erro de paginação, mesmo num 404 recuperável.

## Decisão

1. Definir `visibleWhere: Prisma.ConversationWhereInput` com tenant, status, `controlMode`, `channelMode`, `channelId`, `tagId`, atribuição (incluindo lista de staff do ator) e pesquisa literal escapada. Reutilizar **exatamente este predicado** na verificação do UUID de `after` e na via de listagem Prisma. Cursor que falha a verificação devolve HTTP 404, sem expor se existe noutra lista ou tenant.
2. Se `unreadOnly=true` e houver `after`, exigir também, em SQL parametrizado sob `TenantScope`/RLS, pelo menos um `inbox_events.event_type='message.received'` da conversa cuja sequência ultrapasse `inbox_read_cursors.last_read_sequence` **do ator autenticado**. A via paginada SQL continua com os mesmos filtros, `ORDER BY` e `LIMIT 51`; nunca filtrar depois de paginar. Os endpoints não marcam mensagens como lidas por si.
3. A mudança de atribuição, atualização de pesquisa ou marcação como lida entre páginas pode invalidar a âncora. O Flutter, exclusivamente quando uma chamada `load(more:true)` recebe `ApiFailure(404)` e a geração da lista ainda é atual, realiza **uma** nova chamada `load()` sem cursor, preservando os filtros e `sort`. Não reexecutar `more:true` nem concatenar com linhas potencialmente obsoletas. Um 404 na primeira página, 401, 403 ou erro inesperado segue a política atual de limpeza dos dados, mensagem de erro e retry explícito.
4. Preservar o modelo tenant/RLS/RBAC `messages:read`, índice existente para ordenação recente, ID UUID do cursor, contrato 50+1 e o schema 62. Sem efeitos em takeover, modo IA, despachos, idempotência, fencing ou SSE.

## Verificações e limites

Integração HTTP verifica incompatibilidade de cursor `mine`, `unassigned` e `q`; alteração real de atribuição; cursor de não lidas válido antes e inválido depois de inserir o cursor de leitura do próprio ator; combinação com `sort=recent` e validação 404, enquanto `GET` inicial mantém resultados. Widgets simulam 404 em página seguinte, verificam refresh sem `after` e sem misturar linhas antigas, mantendo `unreadOnly` e `sort`; outro teste força 403 e confirma limpeza imediata sem retry automático.

Entre a validação e seleção, escritas concorrentes podem ainda mudar o estado, e entre páginas pode haver reordenação por novas mensagens. Não são prometidos snapshots históricos nem retries automáticos para falhas de autorização.
