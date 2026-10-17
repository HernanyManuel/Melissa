# ADR-090 — Filtro de conversas por etiqueta no inbox

## Estado

Fatia incremental da Phase 8 no PR draft #7, sem merge, deploy ou integração WhatsApp live.

## Contexto

A ADR-088 disponibiliza um catálogo de etiquetas por tenant e associações reversíveis a conversas. O inbox já suporta pesquisa literal `q`, cursor `after`, paginação fixa de 50 e atualização de estado via SSE. Faltava um filtro operacional que não enumerasse IDs de outros tenants nem descarregasse todos os vínculos para filtrar no cliente.

## Decisão

- `GET /tenants/:tenantId/conversation-tags` devolve `{items:[{id,name}]}`, ordenado por nome e ID e limitado a 100 etiquetas. Exige `messages:read`; a resposta exclui os campos de auditoria e os IDs internos do tenant. Não é necessário selecionar uma conversa para consultar o catálogo.
- `GET /tenants/:tenantId/conversations?tagId=<uuid>&q=<text>&after=<uuid>` aplica o filtro por etiqueta **na consulta à BD**, usando a associação composta por `tenantId`, `conversationId` e `tagId`. O filtro `tagId` é opcional, validado como UUID; uma etiqueta ausente do tenant devolve 404. O cursor de continuação tem de referir uma conversa do mesmo tenant com essa etiqueta. A pesquisa `q`, o tamanho de página 50, a ordenação por ID e a contagem de não lidas por operador mantêm-se.
- O Prisma passa a declarar a relação já suportada pelas FKs da migração 61; **não há migração SQL nem alteração de privilégios**.
- O Flutter obtém o catálogo mediante ação explícita no filtro, sem exigir conversa selecionada. Apresenta opções localizadas para filtrar por etiqueta e regressar a todas as etiquetas. Mudar o filtro reinicia a paginação e descarta respostas de listagem desatualizadas. As atualizações por SSE conservam `tagId` e `q` até que o operador altere o contexto; uma mudança de tenant ou revogação limpa o estado.
- O filtro não cria/desliga etiquetas, não envia mensagens, não altera contadores de leitura e não gera chamadas Meta.

## Verificação

O CI [38030981789](https://github.com/HernanyManuel/Melissa/actions/runs/38030981789) passou backend (format/lint/typecheck, PostgreSQL com RLS, integração e worker), Flutter (analyze, testes, build web) e Docker Compose. Testes HTTP cobrem catálogo mínimo, isolamento por tenant, `tagId` inválido/desconhecido, composição com `q`, cursor e remoção do vínculo. Teste Flutter cobre seleção da etiqueta, pesquisa combinada, preservação de filtros em `Carregar mais` e reposição de todas as etiquetas.

## Limites

- O catálogo tem **máximo de 100 etiquetas**, sem paginação ou procura no servidor; esta fatia não acrescenta gestão de catálogo nem filtro por múltiplas etiquetas.
- O filtro procura apenas conversas do tenant autorizado, não significa atribuição pessoal ao operador. Os dados permanecem sujeitos às permissões existentes.
- As contagens de não lidas continuam por operador e apenas para a página obtida; o aviso visual transitório não é uma notificação push. Sem produção live, merge ou deploy.
