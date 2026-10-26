# P10 — repeated write-probe evidence (schema 79)

## Provenance
Run https://github.com/HernanyManuel/Melissa/actions/runs/40276230864, commit `945c16b1afbb72c6ec97a2f72654262d8fbc7d18`, artifact `p10-synthetic-large-sql-plans` (ID `12630436613`). All 12 expected write-probe files present. Disposable PostgreSQL, schema 79, synthetic two-tenant asymmetric dataset. Every configuration measured three successive rollback-only UPDATE probes of 500 rows in each table with `EXPLAIN (ANALYZE, BUFFERS, WAL)`. This is not a representative INSERT throughput test or a clean fresh-database randomized experiment.

## Raw execution times (ms) and median

| Configuration | Conversations (three samples; median) | AI turns (three samples; median) |
| --- | --- | --- |
| Baseline | 48.104, 32.940, 33.230; **33.230** | 70.232, 65.156, 66.001; **66.001** |
| Conversations index | 35.445, 33.932, 34.103; **34.103** | 65.426, 65.253, 70.803; **65.426** |
| Turns index | 33.759, 33.322, 33.722; **33.722** | 66.241, 66.309, 67.661; **66.309** |
| Both | 34.389, 33.689, 33.991; **33.991** | 65.956, 65.546, 66.386; **65.956** |

## WAL bytes (three samples; median)

| Configuration | Conversations | AI turns |
| --- | --- | --- |
| Baseline | 426228, 364477, 365035; **365035** | 258376, 250820, 243885; **250820** |
| Conversations index | 407465, 408045, 417248; **408045** | 243915, 243937, 245837; **243937** |
| Turns index | 374706, 369664, 367068; **369664** | 283698, 283426, 286556; **283698** |
| Both | 410054, 409725, 408382; **409725** | 331776, 283922, 284315; **284315** |

Combined compared to baseline median WAL: conversations **+12.2%**, turns **+13.4%**. These percentages are observations, not estimates of causal index-only write amplification: repeated transactions, full-page images, page dirtiness, checkpoints and cache are uncontrolled.

## Buffers and reliability

Baseline first conversation update: 11535 shared hit / 1140 read / 1161 dirtied / 925 written; second/third: 13638/0/18/18 and 13682/0/18/18. Baseline turns first: 6836 hit / 5968 read / 989 dirtied / 1075 written; second: 8402/4907/16/12; third: 8454/4874/9/23. Across other scenarios, turns continue to have thousands of reads per update. This shows materially different page/cache conditions even within a configuration.

The experiment reverses earlier fixed index-scenario order but still runs a single order in one shared disposable database. Only three probes per configuration, each with rollback, and none inserts new parent/child records. It is therefore not an independent randomized, sustained-concurrency or INSERT benchmark.

## Decision

Keep both candidate indexes out of the product schema. The read benchmark showed benefits for the small tenant, but mixed benefit for the large one; this write experiment suggests additional WAL with both candidates and insufficient control for a migration decision. Next: isolated fresh-database experiments with randomized scenario order, repeated representative INSERT workloads, recording indexes' size, WAL, latency distribution and actual RLS query plans. Schema 79, PR #10 draft above PR #7 draft, and external Stripe TEST ADR-121 pending remain unchanged. No merge, deploy, Stripe LIVE or paid entitlement activation.
