# ADR 037 — Persistent internal mock processing

Status: accepted, incremental Phase 4 scope.

The internal OutboundMockProcessor serializes on the tenant row and revalidates
the originating membership, active mock WhatsApp channel, customer and conversation.
An immutable, tenant-isolated result and audit event commit together. Repeated calls
return the same terminal result, including after revocation or process restart.
Rejection is terminal; restoring access does not revive an old command. Session expiry
does not cancel an already accepted intent; current membership authorization is checked.

Only the network-free MockMessagingProvider executes inside this transaction. Its
recipient reference is an opaque customer UUID, not a telephone number. A fresh provider
instance bounds memory. Failed processing rolls back and may be retried. This design
must not be reused for external network sends: they require an outbox, dispatcher,
provider idempotency, reconciliation and explicit uncertain-delivery handling.

Schema 17 adds a composite FK to the original intent, forced tenant RLS, constrained
mock receipt identity, and SELECT/INSERT-only runtime grants. No message, delivery
confirmation, real WhatsApp send, or conversation timestamp is fabricated.

The processor is not wired to HTTP or workers. Its tenant argument is trusted internal
context only; future jobs must supply an opaque ID resolved through an authoritative
database routing envelope. Existing HTTP/UI receipts still mean stored intent only.
Queue dispatch, retries/dead letters, result API/UI and live sends remain pending.

Integration coverage includes concurrent replay, a new processor instance, revocation,
closed conversations, provider failure rollback, cross-tenant reads and denied deletion.
