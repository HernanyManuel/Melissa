# ADR-083 — Validade e abandono explícito de respostas humanas preparadas

## Estado

Aceite como fatia incremental da Phase 8, condicionada a validação operacional real antes de ativação WhatsApp live. O workflow funcional [37916802403](https://github.com/HernanyManuel/Melissa/actions/runs/37916802403) passou com backend, Compose e Flutter verdes no commit `7fda06b28b0078b7f1a49d8384bbd3063625e3cf`.

## Contexto

A ADR-082 separou a preparação de uma resposta humana, gravada em `human_outbound_intents` **sem dispatch**, da confirmação explícita, que cria `human_outbound_dispatch`. Isto tornou o reload recuperável sem texto persistente no navegador, mas deixou preparações abandonadas ou esquecidas recuperáveis indefinidamente e ainda confirmáveis enquanto o `mode_epoch` não mudasse.

## Decisão

1. **Prazo fixo de 24 horas**, medido a partir de `created_at` da intenção. Sem alterar estados de despacho, um registo apenas preparado e mais antigo do que o prazo passa a apresentar o estado calculado `expired` em `GET /conversations/:id/manual-replies/latest` e em replays idempotentes de `POST /manual-replies/prepare`. O `POST /messages` recusa com 409 uma confirmação de preparação expirada. Uma intenção que já tem dispatch continua a apresentar `pending/accepted/rejected/failed` e não é alterada pelo prazo de preparação.
2. **Abandono explícito:** `POST /conversations/:id/manual-replies/abandon` com `{requestId: UUID}` usa a sessão e o tenant autorizados (`conversations:reply`) e resolve exclusivamente a intenção de `(tenant_id, actor_id, request_id)` pertencente à conversa. A transação aplica o mutex de tenant já usado pelo serviço. A intenção sem dispatch recebe `abandoned_at`, é auditada, e passa ao estado `abandoned`. Repetir o abandono devolve `duplicate:true`. Intenção inexistente ou alheia à conversa devolve 404; intenção com dispatch, mesmo com envio já falhado, devolve 409. O abandono nunca promete cancelar pedidos ao provider.
3. **Migração 57:** acrescenta `human_outbound_intents.abandoned_at TIMESTAMPTZ(6) NULL`. A role `melissa_runtime` recebe permissão de UPDATE apenas sobre esta coluna; RLS continua a impor o tenant. Os campos `request_id`, `content_text`, ator, conversa e `mode_epoch` permanecem imutáveis à role operacional. O health check passa a exigir schema version 57.
4. **Flutter:** ao recuperar `expired` ou `abandoned`, apresenta o resultado sem botão de confirmação e permite iniciar uma resposta nova por ação explícita. Apenas o estado `prepared` apresenta a ação «Abandonar preparação». O operador vê a confirmação de abandono, mas um 409 ou resposta de rede incerta desencadeia reconciliação por GET; não há dispatch automático.

## Testes

Workflow [37916802403](https://github.com/HernanyManuel/Melissa/actions/runs/37916802403) com três jobs verdes: formatação, lint/typecheck, testes unitários e integração PostgreSQL/RLS, worker/Redis recovery, OpenAPI, Compose e Flutter analyze/test/build web. A integração cobre abandono idempotente, isolamento de outro ator/tenant, recusa de abandono de dispatch existente, recusa de confirmação após abandono e expiração, replay da preparação que preserva o estado, e ausência de dispatch. O Flutter testa abandono de preparação recuperada sem enviar e apresentação de preparação expirada sem botão de confirmação.

## Limites

- **Não é eliminação física nem retenção de dados:** `content_text` e a chave idempotente continuam guardados para prova/reconciliação, mesmo após expiração ou abandono. A retenção/eliminações seguras precisam de uma política separada que respeite auditoria, privacidade e referências existentes.
- **Não existe scheduler de expiração:** a validade é calculada em leitura e confirmação. Uma página que fique aberta mais de 24 horas pode mostrar `prepared` até nova consulta, mas o backend recusa confirmação tardia com 409; nunca dá acesso a um despacho fora do prazo.
- Clientes legados que enviam diretamente por `POST /messages`, sem uma preparação prévia, mantêm o comportamento anterior de criação+queue imediatas. A validade aplica-se apenas a intenções preparadas.
- Só a última intenção do próprio ator na conversa é apresentada no GET. Intenções anteriores não desaparecem, e o painel completo de gestão de rascunhos fica para uma próxima fatia.
- `pending` é fila durável; `accepted` é aceitação pelo provider, **não entrega**. Não foram usadas credenciais Meta reais, não houve merge/deploy e o worker live continua opt-in.
