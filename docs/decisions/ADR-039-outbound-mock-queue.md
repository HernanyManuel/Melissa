# ADR 039 — Durable outbound mock dispatch

Schema 18 creates a minimal routing envelope atomically with each new accepted
intent and its audit event. Previous stored-only intents are deliberately not
backfilled or activated on replay. Readiness requires schema 18.

The existing worker now discovers up to 50 due envelopes per second and publishes
opaque ID/attempt jobs to a dedicated BullMQ queue. No tenant, text, recipient or
credential travels in jobs. Tenant routing comes exclusively from PostgreSQL.
Global SELECT on envelopes is an explicit worker discovery exception: the table
contains only UUIDs and lifecycle metadata. RLS scopes INSERT/UPDATE; runtime
cannot alter identity/tenant or delete envelopes. Payload/results remain tenant-scoped.

Processing revalidates current permissions and mock eligibility. PostgreSQL results
provide deduplication independently of Redis job retention. A crash between result
commit and dispatch completion is recovered by reading the committed result. Retry
settlement checks for that result first, under the tenant lock. Stale attempts do
not consume retry budget. Five recorded processing failures become terminal failed,
with exponential delays of 1/2/4/8 seconds between attempts and transactional audit.
Redis/DB transport failures that prevent recording do not consume this budget;
the dispatcher keeps rediscovering pending rows after recovery. Process-crash loops
without recorded errors are not bounded by the five-failure budget.

No automatic retry of terminal failed/rejected rows, dead-letter UI, retention,
fairness guarantee across tenants, load benchmark, or real provider delivery is
implemented. API/UI still report stored intent, not queue or delivery status.
Expose processing status in a subsequent contract/UI increment. No WhatsApp sends,
message-history entries, deployment or merge are included.

Integration tests pause only the disposable test queue for fault injection, exercise
five failures/stale attempts/RLS/identity grants, simulate the result-commit crash gap,
and resume to verify discovery by the separate real worker. This is not a SIGKILL
test of outbound, a Redis failover test, or a production migration rehearsal.
