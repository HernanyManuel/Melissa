# P10 — Candidate-index comparison on disposable large/asymmetric PostgreSQL

## Provenance

GitHub Actions run [#40274240358](https://github.com/HernanyManuel/Melissa/actions/runs/40274240358), commit `fcce1d114d9dac5c03e2aadc8dcf1cbf70d146bd`, artifact `p10-synthetic-large-sql-plans` (ID `12630110507`, 20 files). PostgreSQL 16.15, schema 79, disposable GitHub Actions service. Queries run as `melissa_runtime` with tenant RLS and fixed 30-day UTC window. `ANALYZE` was performed after data load and candidate-index changes.

Tenant 0: 100,000 conversations / 300,000 turns / 300,000 audits; tenant 1: 10,000 / 30,000 / 30,000. Two observations per tenant/configuration. First baseline measurement preceded all experimental index creation. Tested each candidate separately and both together, removing experimental indexes and analyzing between configurations; final absence was explicitly checked.

## SQL EXPLAIN ANALYZE execution times (milliseconds, median of two)

| Tenant | Index configuration | Conversations | AI turns | Audit |
| --- | --- | ---: | ---: | ---: |
| Large | Baseline | 24.379 | 54.795 | 54.659 |
| Large | Conversations only | 26.166 | 54.798 | 46.233 |
| Large | Turns only | 22.201 | 53.595 | 45.487 |
| Large | Both | 26.159 | 53.823 | 45.666 |
| Small | Baseline | 3.771 | 11.989 | 7.380 |
| Small | Conversations only | 2.504 | 12.518 | 7.343 |
| Small | Turns only | 3.814 | 8.966 | 7.514 |
| Small | Both | 2.645 | 9.155 | 7.423 |

Do not treat cross-scenario audit fluctuations as an index effect: the audit index was unchanged. Configuration tests ran sequentially, not randomized; runner load and cache state may differ.

## Plans, selectivity, storage

- Large tenant: base query uses parallel sequential scans for conversations and AI turns; with the conversations candidate the planner switches that query to bitmap heap and index scans, without consistent execution-time improvement. AI turns remain parallel sequential scans even with the turns candidate. Audit remains parallel sequential scan on large tenant.
- Small tenant: conversation candidate replaces the tenant-only primary-key bitmap scan with an index bitmap scan over tenant+date; turns candidate similarly uses a bitmap scan of `p10_bench_ai_turns_started_idx` instead of `ai_turns_pkey`. Audit continues using its existing `audit_events_tenant_id_created_at_idx`.
- Window selectivity: approximately half of each tenant's records are inside the 30-day period, and 5,010/15,000/15,000 match in small tenant, 50,010/150,000/150,000 in large tenant.
- New index size: conversations 802,816 bytes (784 KiB); AI turns 2,392,064 bytes (2,336 KiB); combined 3,194,880 bytes (3,120 KiB). These are measured PostgreSQL relation sizes, not write amplification or total maintenance cost.
- RLS cardinality estimates continue to significantly underestimate scan output on tenant-scoped heap nodes even when index-stage estimates are close to actual; separate investigation needed.

## Engineering decision

**No product schema change approved.** Measured improvements of ~34% for small-tenant conversations and ~25% for small-tenant AI turns in this run, but no consistent benefits for large tenant. Only two warm/mixed-cache repetitions per configuration, with unquantified insert/update overhead; this does not establish an SLA improvement. Run randomized/repeated comparisons and quantify insertion costs plus index storage before any migration proposal. Keep schema 79; PR #10 draft stacked on PR #7; Stripe TEST ADR-121 external verification remains pending. No merge, deploy, Stripe LIVE or paid entitlement activation.
