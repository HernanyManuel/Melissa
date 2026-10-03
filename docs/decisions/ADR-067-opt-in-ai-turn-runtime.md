# ADR-067: Opt-in AI conversation turn runtime

Status: Accepted

## Context

ADR-066 makes the inbound-to-AI handoff durable, but persistence alone must not start model inference. The worker needs a separate composition boundary that can consume `ai_turn_dispatch`, resolve all tenant and conversation identity on the server, execute only explicitly authorized tools, and remain disabled unless an operator deliberately selects an AI provider.

The runtime must also preserve the existing separation between inference and transport. A deterministic mock provider is useful for local tests, but a synthetic mock response must never become eligible for real WhatsApp delivery through an accidental combination of feature flags.

## Decision

`startAITurnRuntime` is the composition root for one live conversation-turn consumer. It constructs the configured `AIProvider`, `AIGateway`, read-only `ToolRegistry`/`ToolExecutor`, `PrismaAIContextSource`, `PrismaConversationFence`, exactly-once `AITurnLedger`, `ConversationTurnCoordinator`, durable `AITurnProcessor`, and the `ai-conversation-turns` queue.

The first activated registry is intentionally limited to the six implemented read-only tools: `get_business_info`, `get_services`, `get_service_details`, `get_price`, `get_business_hours`, and `get_staff`. The runtime grants only the corresponding read capabilities. The remaining domain tools are not registered and therefore cannot be requested successfully by the model.

`AI_TURN_WORKER_ENABLED=false` is the default. `worker.ts` starts the turn runtime only when this flag is explicitly `true`. Configuration fails closed if the flag is enabled while `AI_PROVIDER=disabled`; there is no automatic fallback to mock.

`AI_PROVIDER=mock` remains allowed for explicit local/test execution of the turn worker, but configuration rejects the combination of an enabled turn worker, enabled live AI outbound worker, and the mock provider. This prevents a deterministic test response from being delivered to WhatsApp.

OpenAI configuration remains server-only and explicit. In Compose, `AI_TURN_WORKER_ENABLED`, `AI_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_TIMEOUT_MS` are injected only into the worker service, not into the public API service.

Inference and delivery remain independent consumers. Enabling the turn worker does not enable WhatsApp delivery. Completed live turns persist their automatic outbound intent transactionally; actual delivery still requires the separately gated `AI_OUTBOUND_WORKER_ENABLED` runtime and its mounted-secret/WhatsApp configuration.

On shutdown the turn consumer is stopped before the automatic outbound consumer and before shared infrastructure is closed, preventing new inference work from being produced while downstream consumers are being torn down.

## Consequences

- The durable inbound trigger can now be consumed end to end without making inference part of the default worker profile.
- Tenant identity, conversation identity, epoch/version, capabilities, and selected tools remain server-owned; queue jobs contain only `{id, attempt}`.
- The model cannot gain access to unimplemented write/handoff tools merely because their target contracts are documented.
- Mock remains useful for tests but cannot feed the live automatic WhatsApp transport.
- OpenAI credentials are not propagated to the API container by the local Compose profile.
- A production release is still not authorized by this ADR. Real-provider staging validation, remaining domain tools, commercial usage/pricing controls, and the broader release gates remain separate work.

## Validation

CI #195 validated the opt-in runtime and fail-closed configuration on the PR head: frozen install, migrations and idempotent seed, format, lint, TypeScript strict, unit tests, separate real worker integration, worker/Redis recovery, OpenAPI, dependency audit, Compose startup/readiness, and Flutter analyze/test/build all passed.
