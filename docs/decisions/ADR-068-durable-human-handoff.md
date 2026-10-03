# ADR-068 — Durable human handoff tool

## Status

Accepted for Phase 5 implementation. Production activation remains subject to the existing Phase 5 release and staging gates.

## Context

`human_handoff` is a side-effecting AI tool. Registering it as a `handoff` effect requires real idempotency: retries or replay of the same model tool call must not repeatedly mutate conversation state or emit duplicate audit events.

A handoff also has to invalidate any in-flight AI work immediately. Melissa already models that invariant through conversation mode fencing: changing an `AI_ACTIVE` conversation to `WAITING_HUMAN` advances `mode_epoch`, so workers holding the previous epoch become stale.

The tool executor derives a server-owned idempotency key from the durable turn and provider tool-call identifiers (`turnId:callId`). Tenant, customer and conversation identifiers come from the authenticated/durable turn context, never from model arguments.

## Decision

Introduce tenant-scoped `ai_handoff_requests` as the durable idempotency record for AI handoff requests.

For a new key, `PrismaHumanHandoff` performs one tenant-scoped database transaction that:

1. records the handoff request with tenant, conversation, customer, turn and bounded reason;
2. locks and validates that the referenced conversation belongs to the same tenant/customer and is currently `AI_ACTIVE`;
3. transitions the conversation to `WAITING_HUMAN`;
4. relies on the existing conversation-state trigger to advance `mode_epoch` and `state_version` when the mode changes;
5. writes one `ai.handoff_requested` audit event.

If the same `(tenant_id, idempotency_key)` is replayed with the same conversation, customer, turn and reason, the operation returns the existing successful result and performs no additional state transition or audit write. Reuse of the key with different scope or reason is rejected as an idempotency conflict.

The tool is live-only. Sandbox execution fails before inserting the idempotency record or mutating conversation state.

Only the bounded reason enum is model-controlled. Tenant/customer/conversation/turn identity and the idempotency key remain server-owned.

The turn coordinator treats successful execution of a handoff-effect tool as terminal `handoff_required`; no automatic delivery text is produced for that turn.

## Security and concurrency properties

- `ai_handoff_requests` is protected by tenant RLS and grants only the columns needed by the runtime role.
- The request key is unique per tenant; replay cannot create a second durable request.
- The conversation row is locked before transition and the update still requires `mode='AI_ACTIVE'`.
- A successful handoff invalidates stale AI workers through the existing epoch fence.
- Audit actor is system-owned; the model cannot choose actor, tenant or target identifiers.
- Sandbox cannot exercise the live handoff mutation.
- The model cannot supply arbitrary notification destinations or external side effects through this tool.

## Verification

Backend integration tests exercise the runtime against PostgreSQL with RLS enabled and prove that:

- the first request transitions `AI_ACTIVE` to `WAITING_HUMAN` and advances the epoch once;
- exactly one handoff request and audit event are persisted;
- replay of the same key returns a duplicate result without another epoch increment or audit event;
- reuse of the key with a different reason is rejected;
- sandbox execution is rejected without creating another request.

Coordinator tests additionally prove that an explicit handoff tool result is persisted as `handoff_required` with consumed usage and without delivery text.

## Consequences

`human_handoff` can legitimately declare `supportsIdempotency=true` and be exposed by the opt-in AI turn runtime under the explicit `conversation.handoff` capability.

This ADR does not add an external paging/push-notification provider. `WAITING_HUMAN` is the durable operational state consumed by the human inbox/takeover flow. Any future external notification channel must be introduced as a separate durable boundary and must not weaken handoff idempotency or fencing.
