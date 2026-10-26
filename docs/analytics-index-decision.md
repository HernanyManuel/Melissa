# P10 — Analytics index decision record (schema 79)

**Decision: DEFER both candidate indexes.** This record consolidates measurements; it does not authorize a migration, release or merge.

## Scope and provenance

- Pull request [#10](https://github.com/HernanyManuel/Melissa/pull/10), draft, stacked on P8 branch / PR #7.
- SQL under runtime tenant RLS on synthetic PostgreSQL (not production), large/asymmetric fixture: tenant A 100k conversations, 300k turns, 300k audits; tenant B 10k/30k/30k.
- Candidate indexes created only in disposable CI PostgreSQL: `conversations(tenant_id, opened_at)` and `ai_turns(tenant_id, started_at)`. Both removed after tests. Product schema **79** unchanged.
- Read plans/results: [comparison report](analytics-index-experiment-results.md), CI [#40274240358](https://github.com/HernanyManuel/Melissa/actions/runs/40274240358).
- UPDATE WAL/time: [three-sample report](analytics-index-write-repeated-results.md), CI [#40276230864](https://github.com/HernanyManuel/Melissa/actions/runs/40276230864).
- INSERT WAL/time: [three-sample report](analytics-index-insert-results.md), CI [#40276980850](https://github.com/HernanyManuel/Melissa/actions/runs/40276980850).
- Documentation-only revision CI [#40297356838](https://github.com/HernanyManuel/Melissa/actions/runs/40297356838) fully green (5 jobs).

## Summary evidence (medians; synthetic only)

| Metric | Baseline | Candidate scenario | Interpretation |
| --- | ---: | ---: | --- |
| Small-tenant conversations read | 3.771 ms | 2.504 ms (conversation index) | ~34% faster in this run |
| Small-tenant AI turns read | 11.989 ms | 8.966 ms (turns index) | ~25% faster in this run |
| Large-tenant conversations read | 24.379 ms | 26.166 ms (conversation index) | No robust benefit |
| Large-tenant AI turns read | 54.795 ms | 53.595 ms (turns index) | Marginal; not robust |
| UPDATE conversations WAL | 365035 bytes | 409725 bytes (both indexes) | +12.2%, three-probe median |
| UPDATE AI turns WAL | 250820 bytes | 284315 bytes (both) | +13.4%, three-probe median |
| INSERT AI turns WAL | 104520 bytes | 142480 bytes (turns index) | +36.3%, three-probe median |
| INSERT AI turns WAL | 104520 bytes | 136364 bytes (both) | +30.5%, three-probe median |

Candidate index sizes in the disposable large experiment: conversations 784 KiB, turns 2336 KiB, combined 3120 KiB.

## Limitations and decision criteria

1. Configuration order and cache/checkpoints not controlled across fresh databases. Replicated within one shared database but not independent replicates; rollback-only write probes still generate WAL and heap churn.
2. No representative sustained workload, concurrent writers, or production-scale latency/SLA distribution. INSERT probe includes customer creation for conversation integrity and so is not an isolated conversation-index write cost.
3. RLS cardinality estimates can be inaccurate; large tenants frequently choose parallel sequential scans, making a blanket tenant/date-index recommendation premature.
4. Keep migration proposal blocked until independent disposable-database comparisons, order randomization, representative INSERT/UPDATE/read load, index storage growth, WAL and p50/p95 with cold/warm cache classification can establish a reliable benefit/cost threshold.

## Guardrails

No schema migrations or production indexes; schema 79 unchanged. PR #10 remains draft, stacked on PR #7. No merge, deploy, Stripe LIVE or paid entitlement activation. External Stripe TEST ADR-121 validation remains pending. This document is an evidence/decision record only.
