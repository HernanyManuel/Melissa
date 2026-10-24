# ADR-081 — Reconciliação de respostas humanas após reload

## Estado

Aceite para a fatia incremental da Phase 8, com validação funcional verde no workflow [37897525313](https://github.com/HernanyManuel/Melissa/actions/runs/37897525313), commit `b10ec6dc598ebfbfea73b11f35a73c969693743e`. Não substitui validação com o provider real.

## Contexto

A ADR-078 estabeleceu uma intenção manual durável, idempotente em `(tenant_id, actor_id, request_id)`, com resposta HTTP que não garante entrega. A ADR-079 introduziu a resposta manual no Flutter, mas a chave e o texto de retry existiam apenas enquanto o widget permanecesse montado. Após reload, era possível desconhecer um POST já persistido ou um resultado incerto.

## Decisão

1. O novo `GET /api/v1/tenants/:tenantId/conversations/:id/manual-replies/latest` é estritamente read-only, usa `TenantService.scoped` com `conversations:reply`, confirma que a conversa existe e seleciona **apenas a intenção mais recente criada pelo ator autenticado** naquela conversa. Devolve `{item:null}` se não houver intenção persistida, ou `{item:{intentId,requestId,text,state,createdAt}}`. Não revela intents de outros atores, credenciais, identificadores de provider ou resultados de entrega.
2. O estado é lido de `human_outbound_dispatch`; a falta incoerente de dispatch falha com 503, não é convertida em `pending`. Nenhuma leitura cria ou reenvia intents. A consulta é autorizada novamente após reload e não precisa de guardar o texto de mensagens em `localStorage` ou `sessionStorage`.
3. O controlo Flutter consulta o endpoint ao abrir uma conversa elegível para resposta manual e ao recuperar de um POST transitoriamente incerto. Mostra a chave e o texto originais de uma intenção persistida e distingue `pending`, `accepted`, `rejected` e `failed`. Não faz POST automático. A opção de iniciar outra resposta exige ação explícita.
4. Uma consulta inicial falhada bloqueia a criação de nova resposta até novo GET. No caso de uma tentativa incerta ainda em memória, a aplicação conserva o par exato `requestId/text`, ignora um resultado GET relativo a outra intenção e permite somente repetir esse par, nunca gerar silenciosamente outra chave.
5. HTTP 200 e `pending` confirmam a persistência em fila, `accepted` representa aceitação do provider e **nenhum destes valores confirma entrega ao destinatário**.

## Testes

O workflow [37897525313](https://github.com/HernanyManuel/Melissa/actions/runs/37897525313) passou com backend, Compose e Flutter verdes, incluindo formatter/lint/typecheck, integração HTTP/PostgreSQL/RLS, testes Flutter e build web. A integração cobre ausência de intenção, recuperação do mesmo `requestId`/texto, isolamento cross-tenant, isolamento por ator mesmo com membership no tenant, staff não atribuído (403), prioridade da intenção mais recente e transição de estado `pending` → `rejected`. Os testes widget cobrem recuperação após remontagem, um 503 cujo pedido já foi persistido e a política fail-closed quando a consulta inicial falha.

## Limites e próximos passos

Esta fatia reconcilia **somente intenções que já existem na base de dados**. Um GET vazio não prova que um POST anterior, ainda em trânsito, nunca venha a fazer commit. A chave de uma intenção não persistida não sobrevive a reload e não há garantia de ausência de duplicação nessa janela; o operador deve confirmar o histórico e o estado antes de novo envio após uma falha incerta com reload. O endpoint devolve só a última intenção do ator, não uma fila de todas as pendentes. Está pendente uma estratégia de recuperação para operações não confirmadas com chave estável entre sessões, mais notificações, contadores unread, notas/tags, painel de cliente completo e E2E com Meta real. O PR continua em draft, sem merge nem deploy.
