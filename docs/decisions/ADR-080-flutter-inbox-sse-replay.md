# ADR-080 — Flutter Inbox SSE com replay e atualização REST

## Estado

Aceite para a fatia incremental de real-time da Phase 8, validada no workflow [37849570752](https://github.com/HernanyManuel/Melissa/actions/runs/37849570752), commit funcional `84fca5867ca0034db9a6fd7bbfb643b444052b3e`. Esta decisão não equivale a Inbox integral, delivery WhatsApp real nem deploy.

## Contexto

O schema 55 e o endpoint `GET /api/v1/tenants/:tenantId/inbox/events` (ADR-077) disponibilizam eventos SSE duráveis, tenant-scoped, com sequência crescente, replay por `after`/`Last-Event-ID` e payload mínimo. O Flutter já dispunha de listagem paginada, leitura de histórico e controlo humano; faltava atualizar a UI quando chegam eventos sem confiar no SSE como fonte de conteúdo.

## Decisão

- `IdentityApi.openInboxEvents` abre um pedido HTTP autenticado de streaming, sem esperar pelo fim de uma resposta SSE saudável. Usa `Accept: text/event-stream`, valida content-type e envia `Last-Event-ID` e `after` na reconexão. Um 401 pode desencadear uma única renovação de sessão; respostas não autorizadas são rejeitadas.
- `parseInboxEvents` reconhece `id`, `event`, `data`, frames delimitados por linha vazia, quebras CRLF, frames repartidos por chunks, comentários/heartbeats e o cursor decimal assinado até `2^63-1`. Rejeita frames malformados ou demasiado longos. Eventos só contêm tipo, sequência e ID da conversa; texto de mensagens continua restrito aos endpoints REST.
- `ConversationsPage` mantém cursor em memória para o tenant atual. Ignora sequências repetidas, cancela a subscrição e elimina estado ao trocar de tenant, e reconecta com backoff de 1 a 16 segundos usando o último cursor conhecido. A subscrição só funciona quando o widget está montado.
- Uma alteração SSE indica que dados devem ser novamente consultados, nunca que o evento autoriza ler texto diretamente. A UI agrupa eventos numa janela curta e faz novas chamadas REST autenticadas para a lista e, quando necessário, histórico da conversa selecionada. Preserva a seleção e as páginas de mensagens previamente abertas dentro do limite de paginação atual. Uma resposta REST tardia de tenant ou geração anterior não substitui o estado atual.
- Refreshes REST de eventos SSE são serializados por geração de tenant. Eventos que chegam enquanto outra consulta está em curso permanecem pendentes e geram uma atualização posterior. Em erro REST temporário, os IDs afetados permanecem em memória e são tentados de novo com backoff; 401/403/404 durante refresh/stream retiram dados sensíveis da vista em vez de os manter numa sessão revogada.

## Verificação

O workflow [37849570752](https://github.com/HernanyManuel/Melissa/actions/runs/37849570752) concluiu com backend, Compose e Flutter verdes, incluindo `flutter analyze --fatal-infos`, `flutter test` e build web. Foram exercitados o parser, os limites de cursor, autenticação e replay, atualização do histórico selecionado, reconexão sem processar sequência duplicada, troca de tenant e a corrida com dois eventos durante uma consulta REST lenta. O workflow anterior [37846050931](https://github.com/HernanyManuel/Melissa/actions/runs/37846050931) também validou a primeira versão da integração SSE; a prova adicional trata especificamente da serialização.

## Limites

O cursor não está persistido entre sessões; recarregar a página reinicia o replay. As atualizações REST preservam um número limitado de páginas já carregadas, não constituem um snapshot transacional do Inbox inteiro e não eliminam a necessidade de reconciliação explícita para históricos longos. A UI não fornece ainda indicadores de unread, notificações, notas/tags, painel completo de cliente, reconciliação de resposta manual após reload ou validação E2E com WhatsApp live. Os workers externos permanecem opt-in/desligados por omissão; o gate P7 de Google Calendar com credenciais reais permanece aberto. Não houve merge nem deploy.
