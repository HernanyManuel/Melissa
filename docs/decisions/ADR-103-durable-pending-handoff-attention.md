# ADR-103 — Atenção in-app persistente para handoffs pendentes

## Estado e escopo

Implementado em `feature/phase-8-inbox`, PR #7 draft, como primeiro incremento da secção §65 e reforço da §35 de `SPECIFICATION.md`. CI final a validar. Não constitui o NotificationService completo nem uma integração de envio live.

## Contexto

O tool `human_handoff` da IA grava a transição `AI_ACTIVE -> WAITING_HUMAN` e emite `conversation.handoff_requested` para o journal SSE. Até aqui o operador podia selecionar `HUMAN_ACTIVE` (já assumido), mas **não** escolher as conversas ainda a aguardar humano. Notificações construídas apenas a partir da entrega SSE falham após reload, desconexão ou na ausência do operador. Criar outra tabela de notificação para espelhar `WAITING_HUMAN` seria redundante antes de existir um serviço de entrega durável multicanal.

## Decisão

1. Fonte de verdade: `Conversation.mode = WAITING_HUMAN` **e** `Conversation.status = open`, lidos no PostgreSQL. `GET /tenants/:tenantId/inbox/handoff-summary` devolve apenas `{pendingConversations: number}`. O endpoint executa `TenantService.scoped(actor, tenantId, 'messages:read')`; o tenant é filtro explícito e RLS é exigido; não há IDs, dados pessoais ou texto no resumo. É uma contagem tenant-wide, não por ator, independente da paginação da lista e dos cursores de leitura.
2. `GET /tenants/:tenantId/conversations?controlMode=waiting` restringe `mode=WAITING_HUMAN` antes de qualquer paginação. O mesmo mapeamento é aplicado à validação de `after` (ADR-101), à ordenação `id|recent`, à janela `activitySince` e à via SQL de `unreadOnly=true` antes de `LIMIT 51`. `human` continua a significar `HUMAN_ACTIVE`, sem alteração retrocompatível. `waiting` é somente leitura: não atribui colaborador nem muda `mode_epoch`.
3. Flutter atualiza o contador por REST no primeiro carregamento e após refresh SSE autorizado, paginação e uma ação de controlo humano concluída. Uma resposta atrasada não pode substituir o contador do tenant atual: `streamGeneration`, geração própria e tenant ID são verificados antes de aplicar. Falhas temporárias escondem a contagem em vez de exibirem um valor antigo; perda de autorização revoga o estado do inbox.
4. A entrada `inbox-handoff-alert`, apenas quando há pendentes, é renderizada dentro do `ListView`, não como nova linha fixa no cabeçalho responsivo. Um toque ativa o filtro `waiting`, preserva restantes filtros/ordenação e reinicia cursor. A mensagem é localizada em seis idiomas com pluralidade numérica simples. Takeover elimina o estado pendente na DB e a próxima consulta atualiza a atenção.
5. Schema 62, nenhum novo worker, migração ou canal externo. A segurança de tomada de controlo e fencing continua nas ADR-076/078; checkpoints SSE e marcações por ler continuam independentes.

## Verificações

Teste de integração: antes dos pedidos, 0 pendentes; 51 conversas existentes passam a `WAITING_HUMAN`; resumo 51; duas páginas 50+1 em ordem ID; SQL de não lidas combinado com `sort=recent` seleciona 50+1; modo inválido 400; RLS entre tenants 404; após remover uma pendência, resumo 50 e cursor obsoleto 404. Widget test: mostra atenção após REST, toque filtra `controlMode=waiting`, desaparecimento quando contador muda, nova leitura após reconstrução da página sem depender de SSE.

## Fora deste incremento

O contador representa **trabalho pendente**, não mensagens de notificação entregues a destinatários específicos. Não tem mecanismo de `ack`/mark-read de notificações, inbox pessoal persistente, email, push, preferências, política de escalonamento, retries por canal ou alertas para falhas de integração/pagamento. Esses elementos continuam no backlog do NotificationService (§65) e exigem contratos e migrations próprios. Não há prova de Meta live ou deploy.
