# ADR 042 — StorageProvider foundation for media

Introduce a vendor-neutral binary StorageProvider with put/get/delete and immutable
metadata (logical key, content type, byte size, SHA-256 checksum and creation time).
It returns no public URL and has no tenant-discovery/list operation. Callers must build
tenant-scoped opaque keys; authorization and database ownership remain backend duties.

MockStorageProvider is development/test only. It is memory-only, applies per-object and
total byte limits, validates keys and lowercase media types, copies all input/output,
and reserves capacity synchronously before yielding. Repeating the same key/type/bytes
returns identical metadata; changed data at that key fails closed. Delete is idempotent.
Checksums include content type and bytes, but are integrity/idempotency evidence—not
malware scanning, authenticity, encryption or a secret.

The provider is deliberately not wired to WhatsApp quarantine yet. Safe media intake
still requires authenticated Meta download, strict redirect/host policy, streamed size
limits, declared-versus-detected MIME checks, malware policy, encryption/key management,
transactional DB references, expiry cleanup and reconciliation. No external URL is
fetched and no raw webhook payload is treated as trusted media.

Production storage remains unconfigured until credentials and provider choice exist.
A future adapter must preserve the contract, server-side credentials, private objects,
encryption at rest, lifecycle policy and idempotent writes. The mock must never be an
automatic production fallback. Unit tests cover concurrency, replay conflict, copies,
capacity, unsafe keys/types, empty objects and idempotent deletion. No schema, API,
Flutter, real media, merge or deployment change.
