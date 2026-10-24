# ADR-076 — Human conversation control foundation

## Estado

Aceite para a primeira fatia da Phase 8. Inbox em tempo real, resposta manual, notificações e UI completa continuam fora deste incremento.

## Contexto

A especificação exige que um handoff coloque a conversa em `WAITING_HUMAN`, que a assunção por um funcionário passe para `HUMAN_ACTIVE`, que a IA deixe de responder automaticamente enquanto o humano controla a conversa e que seja possível reativar a IA. O critério de saída de P8 exige ainda que, após takeover, nenhum novo outbound automático antigo seja autorizado.

A Phase 5 já fornece `mode_epoch` monotónico, trigger de fencing e revalidação final do outbound automático. O controlo humano deve reutilizar essas garantias, não introduzir uma segunda máquina de estados paralela.

## Decisão

O schema 54 adiciona `assigned_staff_id` e `closed_at` a `conversations`. A atribuição usa uma foreign key composta `(tenant_id, assigned_staff_id) -> staff(tenant_id, id)`, impedindo referências cross-tenant também ao nível da base de dados.

É introduzida a permissão `conversations:takeover` para owner, admin, manager e staff. Viewer não a recebe. Um utilizador com role `staff` só pode assumir uma identidade `staff` ativa ligada ao seu próprio `user_id`; roles superiores podem atribuir qualquer staff ativo do mesmo tenant.

Os comandos HTTP autenticados são:

- `POST /conversations/:id/takeover`;
- `POST /conversations/:id/reactivate-ai`;
- `POST /conversations/:id/close`.

Cada mutação corre dentro do scope tenant existente, bloqueia a row da conversa com `FOR UPDATE` e escreve auditoria apenas quando ocorre uma transição real.

O takeover preserva o grafo já aceite em ADR-058:

- `AI_ACTIVE -> WAITING_HUMAN -> HUMAN_ACTIVE`, na mesma transação, para takeover humano proativo;
- `WAITING_HUMAN -> HUMAN_ACTIVE` quando o handoff já ocorreu;
- `AI_PAUSED`, `CLOSED` e estados inconsistentes não podem contornar o grafo;
- repetir takeover pelo mesmo staff em `HUMAN_ACTIVE` é idempotente;
- tentar substituir silenciosamente o staff de uma conversa já ativa devolve conflito.

Cada mudança real de modo continua a ser contabilizada pelo trigger PostgreSQL. Assim, takeover proativo a partir de `AI_ACTIVE` avança `mode_epoch` duas vezes, tornando stale qualquer trabalho AI iniciado antes de qualquer uma das duas fronteiras.

Reativação só permite `HUMAN_ACTIVE -> AI_ACTIVE`, limpa `assigned_staff_id` e avança novamente o fence. Um replay já em `AI_ACTIVE` sem assignment não cria novo evento nem novo epoch.

Fecho define `status='closed'`, `mode='CLOSED'`, limpa assignment e fixa `closed_at`. Repetir o fecho é idempotente e preserva o timestamp original. Conversas fechadas não podem ser reativadas.

## Propriedades de segurança e concorrência

- autorização e tenant scope são revalidados na mesma transação que muda o estado;
- a FK composta impede atribuição cross-tenant mesmo perante um bug de aplicação;
- o row lock serializa takeovers, reativação e fecho concorrentes;
- `mode_epoch` continua gerido exclusivamente pelo trigger;
- o dispatcher de outbound automático exige `AI_ACTIVE` e epoch corrente, portanto um intent criado antes do takeover deixa de ser autorizável;
- nenhum endpoint aceita tenant, epoch ou actor a partir do body;
- todos os efeitos reais geram audit event com actor autenticado.

## Verificação

A integração executa NestJS por HTTP com PostgreSQL/RLS e Redis reais. Prova:

- isolamento entre tenants e rejeição de staff cross-tenant;
- takeover `AI_ACTIVE -> WAITING_HUMAN -> HUMAN_ACTIVE`;
- assignment persistido e epochs monotónicos;
- replay idempotente sem novo epoch ou audit;
- reativação e fecho com os fences esperados;
- fecho idempotente e impossibilidade de reativar conversa fechada;
- um outbound AI persistido antes do takeover é rejeitado pelo dispatcher antes de qualquer provider send.

O workflow 37536138306 ficou integralmente verde no commit `9a6c4abea80bad0c096550ec013ec41f2388b353`: backend, Docker Compose e Flutter, incluindo migrations, formatter, lint, typecheck, unitários, integração, worker recovery, OpenAPI e audit de dependências de produção.

## Consequências e limites

Esta fundação torna as transições humanas uma autoridade server-side compatível com o fencing já existente. O próximo incremento pode publicar eventos de Inbox em tempo real sobre estados já seguros.

Ainda não existem WebSocket/SSE, replay de eventos de real-time, notificações in-app/email, resposta manual de staff, notas/tags ou a UI Inbox completa. O gate externo de P7 para validar Google Calendar com credenciais reais também permanece aberto.
