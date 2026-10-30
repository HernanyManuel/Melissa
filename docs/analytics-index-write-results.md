# P10 — Disposable index write-probe results (schema 79)

## Evidence

- GitHub Actions [#40274849074](https://github.com/HernanyManuel/Melissa/actions/runs/40274849074): five jobs succeeded.
- Tested HEAD `0650306b3201a2a40bf2db2b4517fee317489175`.
- Artifact `p10-synthetic-large-sql-plans` (ID `12629488979`), 24 files, including four write-probe plans.
- PostgreSQL 16, disposable `melissa_test`; schema 79. Candidate indexes are temporary experiments; they are dropped before job exit.
- `docs/analytics-index-write-probe.sql`: two `UPDATE ... WHERE ctid IN (... LIMIT 500)` operations, against `conversations.opened_at` and `ai_turns.started_at`; each occurs in a transaction reverted by ROLLBACK. This is **one observation per configuration**, not an insertion-throughput benchmark.

## SQL execution times

| Config | Conversations, 500 rows (ms) | AI turns, 500 rows (ms) |
| --- | ---: | ---: |
| Baseline | 37.634 | 69.327 |
| Conversations index | 33.282 | 63.877 |
| AI turns index | 36.800 | 70.120 |
| Both | 32.880 | 66.924 |

The numbers are not normalized for changing cache state, WAL/checkpoint state or runner contention. They **do not establish a write-performance improvement**, even where the observed wall-clock time is lower.

## WAL and top-level buffer counters

| Config | Conversations WAL records | Conversations WAL bytes | Turns WAL records | Turns WAL bytes |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 3017 | 406556 | 2173 | 262244 |
| Conversations index | 3539 | 408927 | 2169 | 246844 |
| Turns index | 3051 | 373746 | 2706 | 284769 |
| Both | 3558 | 414344 | 2736 | 404895 |

Relative to baseline, combined-index turns WAL bytes are ~54.4% higher in this single observation. For conversations with both candidate indexes, WAL bytes are ~1.9% higher. These are not causally isolated index-only overhead; PostgreSQL may generate additional WAL for heap writes, full-page images, page splits, checkpoints and cache effects.

Top-level BUFFERS (shared hit/read/dirtied/written):
- Baseline conversations: 11501 / 1162 / 1175 / 935; turns: 6847 / 5960 / 1019 / 1003
- Conversations-only: conversations 14620 / 30 / 122 / 19; turns 8680 / 4626 / 91 / 11
- Turns-only: conversations 12804 / 910 / 921 / 701; turns 9581 / 5255 / 1063 / 1079
- Combined: conversations 14754 / 30 / 82 / 19; turns 11032 / 3872 / 136 / 91

Large buffer variation reinforces that conditions were not comparable across runs. The probe changes timestamps and rolls back; rollback still emits WAL and can cause physical side effects. It is not a realistic sustained mixed workload, does not measure INSERT, and contains no repetitions within each configuration.

## Decision

**Defer migration.** The earlier read benchmark suggests an advantage for the smaller tenant but little consistent benefit for the larger one. This write probe adds evidence of WAL/maintenance costs, without sufficient controlled repetitions to estimate the trade-off confidently. A more rigorous experiment should randomize scenario order across fresh disposable databases, perform multiple write batches and include representative INSERT workload, before contemplating the candidate `(tenant_id,opened_at)` and `(tenant_id,started_at)` indexes. Do not amend schema 79.

PR #10 and its P8 dependency PR #7 remain draft; no merge, deploy, Stripe LIVE or paid entitlements. External supervised Stripe TEST ADR-121 verification remains pending.
