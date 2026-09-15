# ADR-069 — Atualização fenced do perfil do customer pela IA

- Estado: aceite
- Data: 2026-09-11
- Contexto: Phase 5 — AI

## Decisão

A tool `update_customer` pode alterar apenas um campo permitido por chamada para o customer já associado à conversa corrente. O modelo fornece somente `field` e `value`; tenant, customer, conversation, turn, ambiente, epoch e idempotency key são derivados do contexto confiável do servidor.

Os campos inicialmente permitidos são `display_name`, `email` e `language`. Telefone, notas internas e flags de consentimento não fazem parte do schema da tool e não podem ser alterados por este caminho.

A operação é `live`-only e exige a capability `customer.profile.write`. Antes da mutação, a transação aplica RLS do tenant, bloqueia a conversation correspondente ao mesmo customer e exige `AI_ACTIVE` com `mode_epoch` exatamente igual ao epoch capturado pelo turno. Assim, um worker antigo não pode escrever depois de pause/takeover/retoma.

Idempotência é durável por `(tenant_id, idempotency_key)`. A tabela `ai_customer_update_requests` guarda scope imutável e apenas um SHA-256 canónico do patch; não persiste o valor atualizado. Replay do mesmo scope e fingerprint devolve sucesso duplicado sem repetir a mutação nem o audit. Reutilização da key com outro scope ou patch falha fechada.

Mutação, registo de idempotência e evento `ai.customer_updated` são confirmados na mesma transação. Falha de fence, customer arquivado, abort ou qualquer erro reverte também o registo de idempotência.

## Consequências

- O LLM não escolhe tenant/customer nem consegue atualizar outro customer do mesmo tenant.
- A tool não pode inventar consentimentos ou substituir o número de telefone usado para routing/identidade.
- PII do patch não é duplicada na tabela de idempotência; fica apenas no registo canónico do customer e o audit guarda somente ação/target.
- Uma alteração por call mantém o schema compatível com tool calling estrito e evita exigir ao modelo campos atuais que ele não deve reconstruir.
- Atualizações mais amplas ou novos campos exigem expansão explícita do allowlist e nova cobertura de segurança.

## Validação

A integração PostgreSQL cobre primeira execução, replay idempotente, conflito de key, epoch obsoleto, sandbox fail-closed e preservação de telefone, notas e estados de consentimento. O workflow normal também valida migration 27, formatter, lint, typecheck, unitários, worker real, recovery, OpenAPI, audit, Compose e Flutter.
