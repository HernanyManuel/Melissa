# ADR 045 — Fail-closed WhatsApp media configuration

Add a separate opt-in configuration boundary for the disabled media adapter. It does
not reuse webhook verification/app secrets. Enabling requires a server-side access
token (trimmed, 16–4096 characters), explicit `vN.N` API version and a comma-separated,
lowercase, exact hostname allowlist. Schemes, wildcards, localhost, whitespace, empty
entries and malformed DNS names fail startup with field-only errors. Duplicate hosts
are reduced without widening access.

The factory returns null while disabled and constructs WhatsAppGraphMediaSource only
when the parsed configuration is complete. It performs no request and never substitutes
MockMediaSourceProvider. Environment examples contain empty values and disabled flag;
no host, version, credential or provider claim is invented.

This is configuration readiness, not activation. The factory is not registered in
Nest, and no webhook, worker, database or storage reference consumes it yet. Before
activation, verify current official Meta documentation, test account behavior, secret
management/rotation, permitted egress hosts and production network controls. Add a
credential-reference resolver rather than storing per-tenant tokens in environment
when provisioning is implemented.

Tests cover default-off/null factory, complete construction without I/O, missing fields,
token whitespace, version, exact-host syntax and duplicate normalization. No external
call, schema/API/UI, real credential, merge or deployment change.
