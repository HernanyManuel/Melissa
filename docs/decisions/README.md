# Architecture Decision Records

As decisões arquiteturais são append-only. Uma decisão posterior pode substituir uma anterior, mas o histórico permanece no repositório.

## Fase 4 — Messaging

ADRs 009–052 cobrem identity runtime, inbound/outbound messaging, WhatsApp, quarentena, media ingestion, storage, workers e gates operacionais.

## Fase 5 — AI

- ADR-053 — AI provider/gateway boundary
- ADR-054 — OpenAI Responses adapter
- ADR-055 — Server-owned tool registry
- ADR-056 — Tenant-scoped business read tools
- ADR-057 — Minimal untrusted AI context
- ADR-058 — Conversation state fencing
- ADR-059 — Bounded conversation engine loop
- ADR-060 — Exactly-once AI turn ledger
- ADR-061 — Conversation turn coordinator
- ADR-062 — AI automatic outbox
- ADR-063 — Fenced AI outbound dispatcher
- ADR-064 — WhatsApp live outbound boundary
- ADR-065 — Opt-in AI outbound worker
- ADR-066 — Durable inbound AI turn trigger
- ADR-067 — Opt-in AI turn runtime
- ADR-068 — Durable human handoff tool
