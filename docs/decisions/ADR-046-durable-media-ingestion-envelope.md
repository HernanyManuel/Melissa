# ADR 046 — Durable media ingestion envelope

Schema 19 creates a minimal media_ingestion_dispatch row in the same tenant-scoped
transaction as a newly quarantined WhatsApp media event. Detection requires message
category, one of audio/document/image/video, and string media ID plus MIME fields.
Unknown/status events remain quarantined without media work. Duplicate webhook events
reuse the existing quarantine/event and never create a second envelope.

The envelope exposes only tenant UUID, internal event UUID, fixed `quarantined` state
and creation time. It contains no external media ID, type, URL, sender, phone, payload,
key or credential. Global runtime SELECT is an explicit future worker-discovery
exception; INSERT remains tenant-scoped and runtime receives no UPDATE/DELETE grant.
Composite FK ties it to ciphertext and ON DELETE CASCADE removes it when quarantine
retention purges the payload. Schema readiness advances to 19.

No historical backfill occurs because identifying old media would require decrypting
tenant payloads during migration and could unexpectedly activate external downloads.
No worker consumes these rows yet, and state cannot advance. This preserves work after
HTTP ACK while keeping external transport disabled until credential references,
storage, decryption, reconciliation and operational controls are wired.

Integration tests cover atomic creation, duplicate identity, minimal shape, global
discovery, denied mutation/deletion, tenant-scoped ciphertext and retention cascade.
This is not media ingestion, a queue, Meta validation or a production rollout. No real
request, credential, API/UI, merge or deployment change.
