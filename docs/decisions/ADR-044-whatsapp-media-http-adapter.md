# ADR 044 — Disabled-by-default WhatsApp media HTTP adapter

Implement WhatsAppGraphMediaSource behind MediaSourceProvider without wiring it into
configuration, dependency injection, webhook or worker. Construction requires a
server-side token, explicit version and non-empty exact download-host allowlist. This
prevents accidental activation or a guessed production allowlist while current Meta
documentation and credentials are unavailable for verification.

Metadata is requested only from `https://graph.facebook.com/{version}/{opaque-id}`.
The token is sent solely as a Bearer header. Redirects are rejected. The returned URL
must be HTTPS, contain no user info, use default/443 port, and match one configured host
exactly—no suffix or arbitrary webhook URL trust. Both calls have independent bounded
timeouts. Metadata is streamed to 64 KiB; media is streamed to 10 MiB by default,
checking Content-Length early and accumulated bytes continuously. Declared size and
downloaded MIME must match metadata. Errors collapse to MediaUnavailable without URL,
token or upstream detail. MediaIngestor subsequently validates webhook-declared MIME
and SHA-256 before storage.

The exact graph shape is isolated in this adapter and must be validated against official
Meta documentation and a test account before activation. No default host is claimed as
official. Caller-provided host configuration is security-sensitive and must come from
server deployment policy, not tenants or webhooks. DNS rebinding/IP controls, proxy
policy and egress firewall remain deployment requirements; hostname checks alone do
not provide complete SSRF protection.

Tests use injected fetch only and cover fixed metadata origin, authorization placement,
manual redirects, host/scheme/userinfo/port policy, metadata/body size, MIME/length,
sanitized errors, configuration and IDs. No real request, credential, database record,
schema/API/UI, merge or deployment change.
