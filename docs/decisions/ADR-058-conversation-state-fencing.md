# ADR-058 — Estado versionado e fencing do modo da conversa

## Estado

Aceite para o incremento atual da Phase 5.

## Decisão

Cada conversa possui `mode_epoch` e `state_version` monotónicos. O estado começa no schema V1, com shape exato para intent, stage, service, date e staff. Alterações usam compare-and-swap com tenant, conversation, customer, modo `AI_ACTIVE`, epoch e versão esperados.

Um trigger PostgreSQL gere `mode_epoch`: qualquer mudança real de modo incrementa-o e alterações diretas ao contador são recusadas. O mesmo trigger exige que uma mudança de estado incremente exatamente `state_version`; incrementar sem alterar estado também é recusado. Isto mantém a proteção mesmo quando uma escrita não passa pelo serviço TypeScript.

`ConversationStateService` valida o estado e as transições permitidas. Um worker que leu um epoch/versão antigo recebe `StaleConversationState` e não pode publicar estado novo. Conversas fechadas não podem ser reativadas pela máquina de estados. Contadores internos `BigInt` não são expostos na API pública existente.

## Consequências e limites

- Takeover, pause e handoff invalidam workers antigos através do epoch.
- Concorrência sobre o estado é detetada sem manter transação aberta durante inferência.
- A migration normaliza o estado legado vazio para V1; ainda não há dados de intenção reais a preservar.
- O trigger não cancela uma chamada externa já aceite; a verificação final antes do outbound continua obrigatória.
- Autorização humana dos endpoints de mudança de modo, auditoria e ligação ao worker serão implementadas nos incrementos respetivos.
