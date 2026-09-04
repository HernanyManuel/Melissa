# ADR 038 — Bounded npm connectivity diagnostics

The schema-17 CI passed product tests but failed twice querying npm Bulk Advisory
with timeouts. Logs alone do not establish an npm outage or a pnpm defect.

Before the unchanged mandatory pnpm audit, run two bounded Node HTTP probes:
GET npm ping and POST Bulk Advisory with one fixed public dependency/version.
Each has a 15-second timeout, rejects redirects, sends no credentials, and logs
only endpoint label, HTTP status or sanitized failure class, and elapsed time.
No environment, response payload or exception text is printed. Unit tests use
injected transport, not the network. No dependencies or security exceptions added.

The diagnostic intentionally records failure without failing itself so that the
real audit still runs. HTTP 200 is not a vulnerability result or proof that the
complete audit payload works. No JSON/advisory validation is attempted. Node's
transport may differ from pnpm's; successful probes do not exonerate networking.

Interpretation: both failing suggests broader connectivity; ping succeeding with
bulk failing narrows investigation to POST/endpoint handling; both succeeding
while pnpm fails warrants investigation of the client, full payload, or timing.
These are hypotheses, not root-cause conclusions. Never bypass the audit gate.

No product behavior, schema, live integration, merge or deployment changes.
