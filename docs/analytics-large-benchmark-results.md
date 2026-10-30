# P10 — Large asymmetric synthetic benchmark (schema 79 baseline)

## Provenance and scope

- GitHub Actions: https://github.com/HernanyManuel/Melissa/actions/runs/40273490219
- Tested commit: `8a3fc6aff7024925fcb36af8ae66c3ba09ec8d8c`
- Artifact `p10-synthetic-large-sql-plans`, ID `12629850435`, with four full plans and metadata.
- PostgreSQL 16.15, disposable database, schema 79, `ANALYZE` before measurements, `melissa_runtime` under tenant RLS.
- Tenant 0: 100,000 conversations, 300,000 AI turns and 300,000 audit events; tenant 1: 10,000 / 30,000 / 30,000. Totals 110,000 / 330,000 / 330,000.
- Thirty-day window: tenant 0 50,010 / 150,000 / 150,000; tenant 1 5,010 / 15,000 / 15,000. Repeated twice per tenant.

## Execution time (ms)

| Query | Tenant 0 first | Tenant 0 second | Tenant 1 first | Tenant 1 second |
| --- | ---: | ---: | ---: | ---: |
| Conversations | 19.158 | 19.766 | 3.208 | 2.811 |
| AI turns | 46.615 | 42.342 | 9.444 | 9.879 |
| Audit events | 35.955 | 36.310 | 5.776 | 5.556 |

These are SQL `EXPLAIN ANALYZE` times on CI hardware, not API p95, concurrency, production benchmarks or SLAs.

## Plan selection and buffers

- **Tenant 0:** Parallel Sequential Scan for all three sources, with three worker loops; 50,010 qualifying conversation rows and 150,000 qualifying turns/audits. `conversations`: shared hit=3,929; `audit_events`: shared hit=4,715. `ai_turns`: hit=1,046/read=5,181 in first observation and hit=1,174/read=5,053 in second, with 85 written buffers also reported on the first observation. Not fully warm-cache.
- **Tenant 1:** Bitmap Heap Scan backed by `conversations_pkey`, `ai_turns_pkey`, and `audit_events_tenant_id_created_at_idx`, respectively. Qualifying rows 5,010 / 15,000 / 15,000. Conversation bitmap heap: 358 exact heap blocks and 4,990 rows removed by filter. Turn bitmap heap: 567 exact heap blocks and 15,000 rows removed by filter. Audit bitmap heap: 429 exact heap blocks.
- **Estimates under RLS:** Tenant 0 parallel conversation scan estimates 105 rows per worker versus 16,670 actual; AI turns 311 versus 50,000; audit 315 versus 50,000. Tenant 1 heap scan estimates 24 conversations versus 5,010, 75 turns versus 15,000 and 74 audits versus 15,000. The tenant predicates and RLS are included, but the cause of misestimation has not been experimentally isolated.

## Interpretation and decision

The larger tenant changes the planner's choice from tenant-key bitmap access to parallel full-table scans; this is a material effect of table size, distribution, date selectivity and RLS estimation. The large tenant's AI-turn query is the slowest of the three (42–47 ms) and shows physical reads, but no production latency requirement or end-to-end SLA has been demonstrated as violated.

**No schema change or product index approval.** Candidate `(tenant_id,opened_at)` and `(tenant_id,started_at)` indexes merit **isolated disposable-DB A/B experiments** before a migration is proposed, including data load/write overhead, index sizes, planner estimates and a like-for-like before/after comparison. Keep PostgreSQL schema version 79, PR #10 draft above PR #7 draft; no merge/deploy, Stripe LIVE, paid entitlements or inferred clearance of external Stripe TEST ADR-121.

## Caveat

The overall CI of run #40273490219 failed because `pnpm format:check` flagged the changed seed script; the isolated `analytics-large` job itself succeeded. Formatting correction was made on subsequent commits, independently requiring a green CI.
