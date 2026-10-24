# ADR-079 — Incremental Flutter Inbox human controls

## Estado

Aceite como primeira fatia da UI da Phase 8. Validação integral de CI no workflow [37844039975](https://github.com/HernanyManuel/Melissa/actions/runs/37844039975), commit funcional `e1327e8c43b234db270241b8aee1c7495a91a9d3`. Não equivale a uma Inbox completa nem a validação de WhatsApp live em staging/produção.

## Contexto

A interface existente de conversas já permite pesquisa, paginação e leitura tenant-scoped, mas não expõe o controlo humano do schema 54 nem o composer durável do schema 56. É necessário ligar as operações existentes sem contornar RBAC, RLS ou `mode_epoch` do backend. A especificação exige posteriormente três painéis, histórico, notificações, notas/tags e atualizações em tempo real.

## Decisão

Reutilizar `ConversationsPage` para uma primeira fatia funcional. `ConversationHumanControls` recebe tenant, conversa selecionada e `IdentityApi`, com uma identidade de widget distinta por tenant/conversa, sem cache partilhada entre seleções.

O componente apresenta o modo da conversa e liga às operações REST já implementadas: `POST takeover`, `POST reactivate-ai` e `POST close`. O takeover obtém colaboradores via `GET /tenants/:tenantId/staff`; a lista local só oferece colaboradores ativos, mas o backend continua a confirmar identidade, permissões, atribuição e tenant. As respostas de controlo atualizam a seleção e a linha da lista apenas depois de uma resposta válida. Em caso de revogação HTTP 401/403/404, a página recarrega e descarta dados locais sensíveis.

O composer só aparece para uma conversa `HUMAN_ACTIVE` com atribuição e canal em modo WhatsApp live; o backend continua a ser a autoridade sobre canal, pertença e modo. O formulário usa uma chave UUID gerada localmente e congela `requestId` e o texto exato para a mesma tentativa. Uma resposta de rede incerta não cria uma segunda chave: o operador pode repetir explicitamente o pedido original. Um erro terminal 400/401/403/404/409 bloqueia a repetição no contexto atual. O HTTP 200 é apresentado como persistência/estado da intenção, nunca como confirmação de entrega ao destinatário.

O composer não executa automaticamente tentativas após falha, nem controla `mode_epoch` no cliente. Após reativação da IA ou fecho, deixa de permitir novas respostas. Testes de widget protegem contra respostas HTTP tardias de uma seleção antiga.

As novas labels foram localizadas para pt/en/es/fr/it/de.

## Verificação

`apps/flutter_app/test/human_controls_test.dart` cobre: escolha de staff, takeover, resposta manual com erro 503 seguido de retry com `requestId` e texto idênticos, sinalização de aceitação durável, reativação da IA, indisponibilidade do composer em canal mock, fecho e descarte de resposta tardia após mudar de conversa. Os testes de `ConversationsPage` continuam a passar.

O workflow [37844039975](https://github.com/HernanyManuel/Melissa/actions/runs/37844039975) terminou verde nos três jobs backend, Compose e Flutter, incluindo Flutter analyze/test/build web, integração PostgreSQL/RLS, worker recovery, OpenAPI e audit.

## Limites e próximos passos

Esta fatia **não** consome ainda o SSE durável na UI, não implementa notificações, notas/tags, painel completo de cliente, unread count, indicadores de entrega final ou E2E com provider real. O estado idempotente do composer permanece em memória durante a vida do widget: após navegar/sair/recarregar, não existe recuperação automática da chave original. Um utilizador não deve presumir falha e criar uma nova mensagem sem consultar antes o histórico/estado quando o resultado anterior ficou incerto. Persistência e reconciliação do draft/intenção, além da ligação SSE, são requisitos antes de considerar a UX de resposta manual completa.

O worker live continua desligado por omissão e a falta de validação com credenciais reais Meta e Google Calendar não é removida por esta fatia.
