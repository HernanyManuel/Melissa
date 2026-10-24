# ADR-078 — Resposta manual durável com fencing e dispatch opt-in

## Estado

Aceite para a terceira fatia da Phase 8 (schema 56), com validação integral de CI no workflow [37842750417](https://github.com/HernanyManuel/Melissa/actions/runs/37842750417), commit `925f56f17066c08157ffe1d9e625ff02c5cf0eb4`. A integração live com a Meta/WhatsApp em staging ou produção ainda não foi validada; este ADR não autoriza ativação automática.

## Contexto

A especificação exige que funcionários possam assumir conversas e responder no Inbox, sem a IA enviar automaticamente durante `HUMAN_ACTIVE`. O controlo humano do schema 54 (ADR-076) já usa o `mode_epoch` como fence, e o stream SSE do schema 55 (ADR-077) já oferece eventos duráveis sem conteúdo sensível. Uma resposta manual necessita de sobreviver a falhas HTTP/worker, evitar duplicados em retries e recusar trabalho obsoleto quando a conversa volta à IA.

## Decisão

O schema 56 introduz três tabelas:

- `human_outbound_intents`: intenção durável, com tenant, ator, `request_id`, conversa, `mode_epoch`, texto e timestamp; a chave única `(tenant_id, actor_id, request_id)` sustenta a idempotência.
- `human_outbound_dispatch`: estado `pending | accepted | rejected | failed`, tentativas, próxima tentativa e metadados mínimos de aceitação pelo provider.
- `human_outbound_dead_letters`: resultados terminais `retry_exhausted` e `delivery_unknown`.

As tabelas têm RLS forçada e grants explícitos ao papel `melissa_runtime`. Os `INSERT`s Prisma incluem campos geridos por defaults no schema Prisma; por isso, o grant da intenção abrange `created_at` e o do dispatch abrange `state`, `attempts` e `next_attempt_at`, sem conceder `INSERT` irrestrito à tabela. O dead letter é criado com SQL explícito que omite `failed_at`, mantendo o default PostgreSQL sem grant adicional para essa coluna.

`POST /api/v1/tenants/:tenantId/conversations/:id/messages` aceita `{ requestId, text }` com autenticação e a permissão `conversations:reply` (owner, admin, manager ou staff; não viewer). Só aceita conversa em `HUMAN_ACTIVE`, com atribuição válida; o papel staff fica restrito à sua própria identidade de staff. Repetir o mesmo `requestId`, conversa e texto devolve o intent existente; reutilizar a chave com payload divergente devolve 409. HTTP 200 confirma persistência da intenção, **não** envio ou entrega pelo provider.

O intent fixa o `mode_epoch` da conversa. Antes do envio live, o dispatcher revalida modo `HUMAN_ACTIVE`, epoch, atribuição/target e canal WhatsApp live ativo. Reativar a IA invalida intents anteriores. O worker BullMQ publica apenas identificador opaco e número de tentativa; os dados de cliente e conteúdo são resolvidos dentro do scope tenant da base de dados. O runtime requer `HUMAN_OUTBOUND_WORKER_ENABLED=true` e configuração explícita de secrets/provider; por omissão está desligado e não existe fallback mock silencioso.

Após aceitação pelo provider, a aplicação persiste o ID do provider, timestamp, mensagem outbound de staff (`ai_generated=false`, `status=accepted`) e evento `message.sent` no log do Inbox. Replays e falhas são tratados pelo estado durável do dispatch; entrega ambígua é registada como terminal, sem presumir que uma segunda chamada ao provider é segura. Não se equipara `accepted` a entrega no dispositivo do cliente.

## Propriedades de segurança e concorrência

- O `mode_epoch` impede o envio de intents humanos obsoletos após mudança de modo, complementando o fence dos outbounds automáticos da IA.
- Membership, RBAC, tenant scope, atribuição e canal são revalidados do lado do servidor; cliente não escolhe epoch nem ator.
- A unicidade de `requestId` por tenant/ator impede duplicação da intenção em retries equivalentes.
- O dispatcher não presume que uma resposta HTTP 200 ao operador signifique aceitação ou entrega pelo WhatsApp.
- Falhas ou resultados ambíguos são registados de forma durável; o worker live mantém-se opt-in.
- O stream SSE transporta apenas referências ao evento `message.sent`, não o texto enviado.

## Verificação

A integração `human-reply.integration.test.ts` usa NestJS por HTTP, PostgreSQL/RLS e um provider de teste injetado. Cobre takeover, criação da intenção, replay idempotente, conflito com payload divergente, isolamento cross-tenant, persistência após aceitação, histórico outbound, evento `message.sent`, reativação da IA e rejeição de intent antigo por fencing. Testes unitários cobrem o dispatcher, estados de falha e envelope BullMQ.

O workflow [37842750417](https://github.com/HernanyManuel/Melissa/actions/runs/37842750417) ficou integralmente verde no commit `925f56f17066c08157ffe1d9e625ff02c5cf0eb4`: migrations/readiness schema 56, formatter, lint, typecheck, unitários, integração com worker real, recuperação Redis, OpenAPI, audit de dependências, Compose e Flutter.

## Consequências e limites

A Phase 8 dispõe de backend para resposta humana durável e fenced, mas não de composer Flutter/Inbox completo, notificações, notas/tags, testes E2E da UI ou validação live Meta em staging/produção. O gate externo da Phase 5/P7 para Google Calendar com credenciais reais continua aberto. Estes limites não são removidos pela aprovação do CI.
