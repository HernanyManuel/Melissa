# P10 — Protocol for independent analytics index validation

Status: **proposed follow-up experiment**, not an authorization to create product indexes. Product schema must stay at version 79. PR #10 remains draft and stacked on PR #7.

## Question and candidates

Does either candidate B-tree index — `conversations(tenant_id, opened_at)` or `ai_turns(tenant_id, started_at)` — improve representative tenant-scoped analytics queries enough to justify persistent storage, WAL and write amplification?

Compare exactly four configurations: baseline (neither), conversations only, turns only, both. Measure each independently; do not infer effects from ordering one configuration after another in the same modified database.

## Database reproducibility and safety

- Use isolated, disposable PostgreSQL instances or **freshly restored identical snapshots** for **each** configuration/replicate. Require the local disposable benchmark database name `melissa_test` and verify server/role/schema before running. Never send benchmark writes to production, staging customer data or external managed databases.
- Record PostgreSQL version, exact migrations/schema version, seed script commit, random seed, row counts, table/index sizes, tenancy skew, date selectivity, `ANALYZE` statistics and runtime role.
- Preserve two synthetic tenancy sizes (large: 100k/300k/300k; small: 10k/30k/30k for conversations/turns/audits), and optionally more selectivity profiles, generated deterministically from an explicitly saved seed. No real customer identifiers or Stripe configuration.
- Create candidate indexes **only on the disposable instance**; verify their absence on baseline and after cleanup. Never add a Prisma `@@index` or migration from this protocol alone.

## Order, samples and measurements

1. Predefine a reproducible random scenario order for each independent replicate and save the order/seed; use balanced permutations so all four configurations occupy early and late positions across replicates. Prefer fresh databases rather than relying on permutation alone.
2. Gather at least five **independent** replicate databases per scenario, with multiple within-run samples; state counts separately. Never claim statistical confidence from consecutive samples on one database alone.
3. For read queries, run under the restricted `melissa_runtime` tenant RLS role. Preserve both tenant sizes, query parameters and the date window. Record `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)`, planning/execution times, plan operators, estimated and actual row counts, buffer hits/reads and JIT/parallelism if present. Separate cold-cache and warmed-cache sessions; do not mix them into one headline median.
4. For write workload, use representative parent-child INSERT and UPDATE mixes and record WAL records/bytes, physical page activity, index growth and latency distributions. Distinguish customer+conversation insertion from isolated turn insertion; account for foreign keys and constraints. Rollback probes can characterize overhead but cannot substitute a committed write workload. Run committed workloads **only** against fresh disposable instances reset between replicates.
5. Capture per-sample `p50`, `p95`, range and variability in each workload, with per-replicate medians; publish raw anonymized measurements and scripts. Keep SQL query, role, dataset and concurrency fixed when comparing configurations.

## Decision gates

- **Correctness:** identical tenant isolation/RLS, row counts, query results and plan provenance.
- **Read benefit:** repeatable, practically meaningful improvements in the relevant tenant population and workload, without regressions in other tenant sizes or queries; do not set a post hoc significance threshold.
- **Write/storage budget:** quantify extra WAL, write p95, throughput and index bytes under representative conditions; explicitly compare cost to read benefit.
- **Operational safety:** candidate indexes require a separate explicit architecture decision, migration rollout/rollback plan, lock/CONCURRENTLY risk review, and further CI. A passing synthetic benchmark **does not** authorize production migration.

## Known starting evidence

- [Read A/B and plan results](analytics-index-experiment-results.md): small-tenant improvement, inconsistent large-tenant benefit.
- [Repeated UPDATE results](analytics-index-write-repeated-results.md): higher median WAL with combined indexes in synthetic rollback tests.
- [INSERT results](analytics-index-insert-results.md): turns-index WAL growth in sequential rollback tests; no causal latency estimate.
- [Consolidated current decision](analytics-index-decision.md): **defer indexes**.

The original results are informative exploratory evidence, not independent replication. A future decision should link raw artifacts to a new explicit decision record.

## Immutable delivery boundaries

No migration/index change to product schema 79; no merge or deploy; no Stripe LIVE or paid-entitlement activation. PR #10 and PR #7 remain draft. External supervised Stripe TEST ADR-121 validation is still pending and independent of this performance experiment.
