# ADR-077 — Durable tenant-scoped Inbox event stream

## Status

Accepted for Phase 8 implementation. Production activation remains subject to the existing staging and release gates.

## Context

The Inbox requires near-real-time updates, reconnection recovery and strict tenant isolation. An in-memory WebSocket/SSE fan-out would lose events on process restart and would require sticky sessions or a separate broker before clients could recover missed state.

Conversation content is already available through authenticated REST endpoints. The real-time channel therefore does not need to duplicate message bodies, customer details or internal fencing counters.

## Decision

Introduce a durable `inbox_events` log and expose it through authenticated Server-Sent Events at `GET /api/v1/tenants/:tenantId/inbox/events`.

Each event stores only tenant, tenant-local sequence, bounded event type, conversation ID, optional message ID, optional actor ID and timestamp. Payload content remains behind the existing REST authorization boundary.

Event sequence numbers are monotonic inside each tenant. A database trigger locks the tenant row before assigning `MAX(sequence)+1`, so writers that already operate under tenant transactions serialize without a global sequence or cross-tenant cursor.

The initial request may provide `after`; reconnects may send the standard `Last-Event-ID` header. The server replays rows after that cursor, then polls the durable log. Every poll passes through `TenantService.scoped`, so session/membership revocation is revalidated while a stream remains connected. If authorization disappears, the stream closes without disclosing the reason.

The first event producers are accepted inbound messages, AI handoff requests, human takeover, AI reactivation and conversation close. Producers insert the Inbox event in the same PostgreSQL transaction as the source mutation. Idempotent replays that do not repeat the underlying mutation also do not duplicate the Inbox event.

## Security and concurrency properties

- RLS protects `inbox_events`; the runtime role receives only SELECT and bounded INSERT columns.
- Cursors are tenant-local and reveal no global event volume.
- SSE payloads contain no message text, phone number, customer name, provider credential, prompt, model output or internal epoch.
- Cross-tenant stream authorization uses the same membership/RBAC path as Inbox REST reads.
- Event insertion is transactionally coupled to its source mutation.
- Replay is bounded to batches of 100 and cursors are constrained to signed PostgreSQL BIGINT.

## Verification

Integration tests prove takeover/reconnect replay, cross-tenant rejection, cursor validation, inbound-message event persistence and idempotent handoff event persistence.

## Consequences

Phase 8 gains a restart-safe real-time substrate without adding a new infrastructure dependency. Polling is intentionally conservative for the first implementation; a later PostgreSQL LISTEN/NOTIFY or Redis wake-up may reduce idle polling without changing the durable cursor contract.

This ADR does not implement manual staff replies, notifications, notes/tags or the Flutter Inbox UI.
