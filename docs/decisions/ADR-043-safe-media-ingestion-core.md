# ADR 043 — Safe media ingestion core without network

Add a MediaSourceProvider that resolves opaque provider media IDs and a MediaIngestor
that validates before writing through StorageProvider. The mock source is fixture-only
and performs no network access. Missing media fails closed; returned bytes are copied.

The ingestor accepts only UUID tenant identity, bounded opaque media IDs and an explicit
allowlist: JPEG, PNG, MP3, Ogg audio, MP4 video and PDF. Downloaded type must exactly
match the webhook-declared type. Bodies must be non-empty and at most 10 MiB by default.
When a source supplies SHA-256, format and byte equality are mandatory. The storage key
contains normalized tenant UUID and a hash of provider key/media ID, not the external ID.
Storage provides replay conflict detection and private access; no URL is returned.

This is deterministic validation/storage orchestration, not a Meta adapter. It is not
connected to webhook quarantine or the database because safe external acquisition and
transactional reference/reconciliation are not implemented yet. It does not detect MIME
from magic bytes, scan malware, transcode, decrypt, authorize a user, or clean objects.
Callers must provide tenant identity from verified routing, never request input.

The real adapter remains blocked until current Meta documentation and credentials can
be verified. It must use server-side tokens, authenticated metadata/download calls,
streaming byte limits, strict redirect/host resolution, timeouts and sanitized errors.
Do not use arbitrary webhook URLs. Unit tests cover replay, opaque tenant keys, type,
size, checksum, identity, missing media and empty body. No schema/API/UI/merge/deploy.
