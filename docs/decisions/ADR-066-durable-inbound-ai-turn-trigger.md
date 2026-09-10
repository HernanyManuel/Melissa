# ADR-066: Durable inbound-to-AI turn handoff

Status: Accepted

## Context

Persisting an inbound WhatsApp message and then calling the conversation engine after the transaction creates a crash window: the message can be committed and the process can die before the AI turn starts. Replaying the inbound dispatch is not available after it has been marked processed, so a best-effort post-commit call can permanently lose an automatic reply.

The conversation engine also requires server-owned fencing (`mode_epoch` and `state_version`) and must not trust tenant identity or message payload supplied by a queue job.

## Decision

A live WhatsApp inbound transaction creates a durable AI turn intent atomically with the persisted message when the resolved conversation is `AI_ACTIVE`.

`ai_turn_intents` is tenant-scoped and stores only server-owned execution identity: batch, conversation, customer, `mode_epoch`, and `state_version`. A unique `(tenant_id, batch_id)` constraint guarantees at most one requested turn per inbound batch.

`ai_turn_dispatch` is the global discovery envelope. It contains only the opaque intent ID, tenant routing identity, lifecycle state, retry count, and next-attempt timestamp. Message content is never copied into this globally discoverable table.

The inbound processor does not execute the model or call the coordinator inside the database transaction. It only persists the handoff. A later consumer must resolve the intent from the database, revalidate the conversation/batch/fencing state, and then call the existing `ConversationTurnCoordinator`.

No intent is created for mock inbound, non-WhatsApp channels, non-live channels, or conversations that are not `AI_ACTIVE` at processing time.

Automated audit events use `actor_type='system'` with a null actor ID. The audit action (`ai.*`) carries the subsystem identity. Migration 25 extends the existing audit actor constraint narrowly to support this explicit machine actor; arbitrary actor types remain rejected.

## Consequences

- A committed live inbound message cannot lose its AI handoff solely because the worker crashes after the message transaction commits.
- Duplicate jobs/messages within the same sealed batch cannot create multiple AI turn intents.
- Queue discovery remains payload-minimal and does not trust caller-supplied tenant or conversation identity.
- Human takeover or a later mode/version change can be detected by the consumer before model/tool execution.
- This ADR does not enable automatic inference by itself. The turn consumer remains a separate, opt-in runtime boundary.

## Validation

CI #156 exercised migration 24/25 under the non-owner runtime role and verified the handoff end to end: one trigger for two messages in the same live `AI_ACTIVE` batch, captured epoch/version, pending dispatch, audit creation, database-managed epoch advancement on pause, and zero trigger for the subsequent paused batch. Backend format/lint/typecheck/unit/integration/recovery/OpenAPI/audit, Flutter analyze/test/build, and Compose all passed.
