# ADR 040 — Minimal outbound processing status

The authenticated receipt endpoint returns `pending`, `mock_accepted`, `rejected`,
or terminal `failed`. Legacy intents without a dispatch envelope remain `stored`.
POST reflects current state on replay; a newly accepted intent is `pending`.

No payload, customer, actor, provider ID, attempt count, error, phone or credential
is returned. Tenant scoping and owner/admin authorization remain unchanged; GET never
submits work. `mock_accepted` means only that the network-free simulation succeeded,
never that WhatsApp accepted or delivered a message.

Flutter validates the closed state set and uses distinct copy in six languages.
Refresh is user-triggered and GET-only. Terminal states expose no retry control;
operational retry/dead-letter actions need a separate authorized, audited design.

Tests cover the OpenAPI enum, live state/RBAC/tenant responses, strict client parsing,
pending-to-accepted refresh and stale tenant responses. No schema, real send, history
message, merge or deployment change.
