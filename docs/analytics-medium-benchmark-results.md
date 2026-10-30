# P10 — Medium synthetic analytics benchmark (baseline, schema 79)

## Provenance

- CI run: https://github.com/HernanyManuel/Melissa/actions/runs/40272484004
- Run source commit: `1d3c105a0779cfc9d8bf24b7691dced5fcd384d3`
- Artifact: `p10-synthetic-medium-sql-plans` (artifact ID `12628742824`), containing four unabridged plans and `benchmark-metadata.txt`.
- PostgreSQL: 16.15 (Debian 16.15-1.pgdg12+2), disposable GitHub Actions service; migrations up to schema 79; queries authenticated as `melissa_runtime` with tenant RLS; `ANALYZE` after seeding.
- Synthetic data: two tenants, 10,000 conversations, 30,000 AI turns, 30,000 audit events each (20,000 / 60,000 / 60,000 overall). No production data.
- Window: rolling 30×24-hour UTC, common `[from,to)` for each transaction. Both tenants: 5,010 conversations, 15,000 AI turns and 15,000 audits inside window.
- Two executions of three `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` statements per tenant. All row-count assertions succeeded under RLS.

## Measured execution times (ms)

| Source | Tenant 0 run 1 | Tenant 0 run 2 | Tenant 1 run 1 | Tenant 1 run 2 | Median |
| --- | ---: | ---: | ---: | ---: | ---: |
| conversations | 4.486 | 4.662 | 4.424 | 4.504 | 4.495 |
| ai_turns | 14.816 | 15.234 | 14.547 | 14.686 | 14.751 |
| audit_events | 7.346 | 7.277 | 7.283 | 7.253 | 7.280 |

## Plans and buffers

| Source | Observed scan | Shared hit per query | Scan rows passing | Rows removed by filter |
| --- | --- | ---: | ---: | ---: |
| conversations | Seq Scan | 715 | 5,010 | 14,990 |
| ai_turns | Seq Scan | 1,133 | 15,000 | 45,000 |
| audit_events | Bitmap Index Scan using `audit_events_tenant_id_created_at_idx` + Bitmap Heap Scan | 449 (index 20; heap exact 429) | 15,000 | not reported for the tenant/time restriction |

All four repetitions selected the same scan categories and buffer-hit counts. No `shared read` was reported. Measurements are warm-cache CI query execution times, not cold-cache, concurrency, API end-to-end, or production SLAs.

## Selectivity and estimation

The window selects ~50.1% of each tenant's conversations (5,010/10,000), 50% of turns and 50% of audit events (15,000/30,000). Relative to both tenants' combined tables, approximately one quarter of the rows qualify for each tenant/window query.

For `conversations`, the Seq Scan estimates 25 output rows versus 5,010 actual; for `ai_turns`, 75–76 versus 15,000 actual, despite freshly analyzed tables. The RLS policy adds a tenant equality with `current_setting('app.tenant_id')`, which may contribute to selectivity misestimation; the precise cause is not established. For `audit_events`, the Bitmap Index Scan estimates ~15,147–15,179 rows versus 15,000 actual; the heap node's estimate is ~76 due to the additional RLS filter.

## Decision and outstanding work

**No index migration is approved.** These measurements show sequential scans and estimation inaccuracies but no demonstrated unacceptable latency. Before considering `(tenant_id,opened_at)` or `(tenant_id,started_at)`, obtain a larger/asymmetric synthetic scenario, compare plans and buffers before/after candidate indexes **only in disposable databases**, assess index size and write overhead, and examine the RLS-driven estimate discrepancy. Keep schema 79 unchanged.

PR #10 remains draft and stacked on PR #7. No merge/deploy, Stripe LIVE or paid entitlements. External supervised Stripe TEST ADR-121 verification remains pending.
