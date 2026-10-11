# ADR-095 — Totais globais de mensagens não lidas por operador

## Estado

Fatia incremental da Phase 8, ainda no PR draft #7. Não autoriza merge, deploy ou integração live com a Meta.

## Contexto

A ADR-085 criou cursores de leitura duráveis por operador, e o Flutter passou a apresentar um resumo local das conversas carregadas, filtradas e paginadas. Esse resumo não informa o total de mensagens recebidas ainda não marcadas como lidas quando existem outras páginas, etiquetas, filtros de estado ou conversas atribuídas a outros colaboradores.

## Decisão

- `GET /api/v1/tenants/:tenantId/inbox/unread-summary` devolve `{ "unreadConversations": number, "unreadMessages": number }`. Exige autenticação e `messages:read`, executa-se na transação tenant-scoped já protegida por RLS, sem aceitar `actorId` do cliente.
- O resultado abrange **todas as conversas do tenant autorizado**, independentemente da pesquisa, etiquetas, filtros de atribuição, estado, `unreadOnly` ou paginação da lista. Esta abrangência equivale à permissão atual `messages:read`, que concede acesso às conversas do tenant, não apenas às atribuídas ao ator. Não expõe IDs, nomes ou conteúdo das mensagens.
- Contam-se exclusivamente eventos persistidos `inbox_events.event_type='message.received'` posteriores ao `last_read_sequence` de `inbox_read_cursors` do operador autenticado. O `COUNT(DISTINCT conversation_id)` produz conversas não lidas e `COUNT(*)` produz eventos recebidos ainda não confirmados. Eventos de envio, SSE de controlo e checkpoints do stream não afetam os totais.
- A interface Flutter mantém o resumo preexistente, expressamente limitado à lista carregada, e acrescenta um **resumo do tenant** independente. Reconsulta os totais após listagem REST autorizada, atualização SSE aplicada e confirmação explícita de leitura. Respostas atrasadas de outro tenant ou geração são descartadas; erros de consulta removem o resumo global em vez de mostrar um valor antigo como atual.
- Traduções em pt/en/es/fr/it/de. Não há migração, alterações no dispatcher, mark-as-read automático, push, sons ou exposição de mensagens.

## Verificação

A integração HTTP/PostgreSQL verifica contagem inicial, exclusão de eventos outbound, alterações após confirmação de leitura, independência entre dois operadores com cursores diferentes, permissões viewer e isolamento entre tenants. Testes Flutter verificam independência face ao filtro de pesquisa, atualização após SSE e «Marcar como lida» e descarte de um resultado atrasado do tenant anterior. A compilação e os testes devem passar pelo CI do PR antes de considerar esta fatia validada.

## Limitações

Os totais refletem a base de dados no instante da consulta, não um snapshot atómico com uma lista paginada pedida separadamente. `unreadMessages` conta **eventos de entrada**, não confirmação de visualização humana, qualidade da resposta, nem número de mensagens entregues pelo provider. O contador não restringe permissões por atribuição de staff, não inclui operações offline e não envia notificações fora do inbox. A consulta agregada sobre o tenant deverá ser monitorizada e otimizada caso o volume de eventos cresça substancialmente.
