# ADR-087 — Notas internas imutáveis em conversas

## Estado

Implementação incremental da Phase 8, em PR draft, sem merge/deploy e sem ativação do WhatsApp live.

## Contexto e limites de isolamento

O inbox já permite ler mensagens, assumir conversas, marcar eventos recebidos como lidos e preparar respostas humanas. Uma nota operacional não pode ser enviada ao cliente, exposta ao motor de IA ou confundida com uma mensagem recebida/enviada, nem deve criar despacho, eventos de transporte ou contadores de mensagens não lidas.

## Decisão

- A migração **60** cria a tabela `conversation_internal_notes`, separada de `messages`, `external_events`, `inbox_events`, `human_outbound_dispatch` e filas de IA. A linha contém `tenant_id`, `id`, `conversation_id`, `actor_id`, `request_id`, `content_text` (até 2 000 caracteres) e `created_at`.
- FKs compostas impedem referência a uma conversa ou ator que não pertençam ao tenant. A role `melissa_runtime` tem apenas `SELECT` e `INSERT` de colunas autorizadas, não `UPDATE` ou `DELETE`. A policy RLS obriga correspondência com o tenant da sessão e o autor autenticado na inserção; as operações passam por `TenantService.scoped` com permissão `messages:read`, que exclui `viewer`.
- `POST /api/v1/tenants/:tenantId/conversations/:id/internal-notes` aceita `{requestId, text}`, exige UUID e texto não vazio com limite. O mesmo autor e `requestId` com texto/conversa idênticos devolve `duplicate:true` sem escrever de novo. Chave igual com texto ou conversa diferente devolve 409. A criação e um evento de auditoria `conversation.internal_note_created` (identificador, não texto) decorrem na mesma transação.
- `GET /api/v1/tenants/:tenantId/conversations/:id/internal-notes` devolve as últimas 50 notas, ordenadas por data e identificador descendentes. O cursor `after` tem de corresponder a uma nota na mesma conversa e tenant, caso contrário 404; `next` permite páginas seguintes. A API devolve autor (`actorId`), texto e timestamp.
- O Flutter apresenta uma secção distinta «Notas internas», identificada como visível apenas à equipa; as submissões só usam `internal-notes`, nunca `messages`. Se uma resposta POST se perder, a interface bloqueia alterações ao texto e permite repetir **a mesma chave e o mesmo texto**, evitando notas duplicadas. Há listagem, paginação e atualização explícita. Localizações em pt/en/es/fr/it/de.

## Testes e verificação

Testes de integração cobrem lista vazia, criação, replay idempotente, payload conflitante, texto inválido, conversas inexistentes, isolamento de outro tenant, exclusão de papel `viewer`, paginação inválida, auditoria e ausência de criação de mensagens do cliente. O teste Flutter verifica o reenvio idempotente após resposta ambígua sem qualquer POST de mensagem ao cliente. O workflow completo deverá confirmar migração 60, RLS, Prisma, lint, typecheck, testes de integração com PostgreSQL/Redis e Flutter analyze/test/build web.

## Riscos assumidos

- **Notas imutáveis**, sem editar, apagar, pesquisar texto ou anexos. Não há alteração de permissões por conversa/atribuição: membros do tenant com `messages:read` partilham acesso. `viewer` não acede. A identificação do autor na API é um UUID, sem apresentação de nome no Flutter.
- Notas não são eventos SSE; atualizar a lista manualmente recarrega dados autorizados. Não alteram contagens de não lidas, nem notificações de mensagens. Persistem até existir política de retenção, pedidos de eliminação e tratamento de backups adequados; não afirmar retenção curta ou expurgo automático.
- O texto pode incluir dados pessoais. Não deve constar de logs ou auditoria; a sua política de conservação precisa de revisão antes da produção.
- Esta fatia não ativa WhatsApp/Meta, não efetua merge nem deploy. Etiquetas/tags e painel completo do cliente ficam para etapas seguintes.
