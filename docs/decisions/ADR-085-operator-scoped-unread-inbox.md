# ADR-085 — Contadores de mensagens não lidas por operador na Inbox

## Estado

Fatia incremental da Phase 8 em draft, sem merge nem deploy. Validação funcional no [workflow 37953921259](https://github.com/HernanyManuel/Melissa/actions/runs/37953921259), com backend, Flutter e Compose verdes, incluindo migração PostgreSQL 59, integração HTTP/RLS e testes de interface.

## Contexto

A Phase 8 já tem Inbox paginada, eventos SSE duráveis e respostas humanas seguras. Faltava um estado persistido de leitura: abrir uma conversa num separador não indicava quantas mensagens de entrada estavam por tratar. A Inbox mostra até 50 conversas por página e o histórico de mensagens é paginado por ordem crescente; abrir a primeira página não garante que todas as mensagens posteriores foram vistas.

## Decisão

1. **Fonte de verdade:** `inbox_events` duráveis com `event_type='message.received'`, por conversa e tenant. Mensagens de saída, eventos de handoff/estado e confirmações de leitura não aumentam o contador. A listagem de conversas inclui `unreadCount` (inteiro, zero por omissão) e `unreadUpTo` (sequência decimal da última mensagem recebida, ou null). A query calcula os valores apenas para as 50 conversas da página e nunca devolve conteúdo da mensagem.
2. **Estado separado por operador:** a migração **59** introduz `inbox_read_cursors(tenant_id,actor_id,conversation_id,last_read_sequence,updated_at)`, com chave composta, FKs para membership e conversa, e RLS estrita a `app.tenant_id` **e** `app.actor_id`. A role runtime só recebe leitura, inserção e atualização das colunas necessárias. O health check passa a exigir versão de esquema 59.
3. **Recibo explícito:** `POST /api/v1/tenants/:tenantId/conversations/:id/read` aceita `{ "upTo": "42" }`. Exige `messages:read`, conversa pertencente ao tenant e uma sequência decimal positiva que corresponda a um evento `message.received` **daquela conversa**. Rejeita cursores inventados, futuros, de saída ou de outra conversa. Se o cursor anterior é igual/superior, responde com `duplicate:true` e preserva o máximo. A transação com lock do tenant serializa replays concorrentes, tornando o cursor monotónico.
4. **SSE multi-separador:** quando há avanço efetivo, a mesma transação grava um evento `conversation.read` no fluxo durável. Todos os clientes do tenant recebem apenas IDs/cursor, nunca o conteúdo nem a identidade do leitor no payload público. Os separadores atualizam os contadores por GET REST autorizado. Repetições sem avanço não criam eventos.
5. **Flutter:** badges nas conversas com contagem positiva, ação «Marcar como lida» apenas com histórico carregado e cursor obtido da listagem; não há marcação automática no `open`. O ACK HTTP atualiza o badge local se a conversa e o cursor exibidos ainda coincidirem; atualizações SSE subsequentes usam sempre o servidor como fonte. O controlo humano preserva os metadados da conversa ao atualizar estado.

## Testes e verificação

O workflow [37953921259](https://github.com/HernanyManuel/Melissa/actions/runs/37953921259) concluiu com backend (Prisma/migrações/RLS, formatação, lint, typecheck, testes unitários/integração/worker e OpenAPI), Flutter (analyze, testes e build web), Compose verdes. O teste de integração valida: contador de duas entradas por operador, exclusão de `message.sent`, rejeição de sequências inválidas, recibo e replay monotónico, isolamento de outro operador/tenant e nova entrada permanecendo por ler após o ACK. O teste widget valida badge e que abrir a conversa não envia ACK sem ação explícita.

## Limites

- `unreadCount` é a contagem de **eventos de entrada desde o último recibo do operador**, não uma garantia de que todas as mensagens foram efetivamente vistas ou de que a conversa foi tratada. O botão de marcação pode ser usado mesmo que existam páginas de histórico ainda não carregadas; por isso a ação nunca é automática.
- O `unreadUpTo` é um snapshot da listagem, não um cursor de mensagem arbitrário. Se chegar uma mensagem nova depois de carregar a lista e antes do ACK, ela mantém-se não lida por estar após a sequência confirmada.
- Um evento `conversation.read` é visível aos subscritores SSE autorizados do tenant; não inclui identidade do operador ou conteúdo, mas pode revelar que houve atividade de leitura. Contagens individuais são devolvidas apenas através de REST com RLS por ator.
- Notificações push/browser, alertas sonoros, preferências de notificações, notas/tags, contexto completo de cliente e métricas agregadas não são implementados nesta fatia. Não existe envio WhatsApp nem alterações à habilitação de worker live, sem E2E Meta real, merge ou deploy.
