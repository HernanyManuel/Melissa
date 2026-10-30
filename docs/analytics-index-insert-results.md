# P10 — INSERT probe: three-sample results (schema 79)

## Provenance

GitHub Actions [#40276980850](https://github.com/HernanyManuel/Melissa/actions/runs/40276980850); tested commit `2b7dba33c28e7d19385634d89bf735ffbf46fc2f`; artifact `p10-synthetic-large-sql-plans`, ID `12630328575`. Five CI jobs succeeded. The disposable PostgreSQL database used the unchanged schema 79, the large asymmetric synthetic fixture, and an authorized migration role for rollback-only INSERT probes. Four index configurations: baseline, conversations, turns and both. Experimental indexes are dropped at the end.

Each conversation probe inserts **200 new synthetic customers plus 200 conversations** in one CTE statement. The AI-turn probe inserts **200 turns**, using existing conversations. Both statements execute `EXPLAIN (ANALYZE, BUFFERS, WAL)` inside separate transactions followed by `ROLLBACK`. Three sequential repetitions per configuration. The conversation timing includes customer insertion and FK checks, so does not isolate conversations-index maintenance. Rolled-back writes still incur physical effects.

## Raw INSERT Execution Time (ms; samples → median)

| Configuration | Customers + conversations | AI turns |
| --- | --- | --- |
| Baseline | 10.471, 9.967, 9.512 → **9.967** | 7.904, 6.428, 6.398 → **6.428** |
| Conversations index | 8.225, 8.239, 8.716 → **8.239** | 5.137, 5.253, 5.487 → **5.253** |
| Turns index | 8.091, 7.758, 8.391 → **8.091** | 5.462, 5.365, 5.871 → **5.462** |
| Both | 7.944, 8.894, 8.019 → **8.019** | 5.303, 5.599, 5.403 → **5.403** |

## Raw top-level WAL bytes (samples → median)

| Configuration | Customers + conversations | AI turns |
| --- | --- | --- |
| Baseline | 266792, 255374, 251776 → **255374** | 132336, 104280, 104520 → **104520** |
| Conversations index | 276539, 275021, 261128 → **275021** | 96568, 120424, 143832 → **120424** |
| Turns index | 232677, 268323, 220917 → **232677** | 136048, 157156, 142480 → **142480** |
| Both | 255968, 248733, 244920 → **248733** | 128656, 136364, 142544 → **136364** |

The turns-index scenario has +36.3% median AI-turn WAL bytes versus baseline, and the combined scenario +30.5%; conversation-index alone shows +7.7% median conversation-statement WAL. The combined configuration has lower conversation-statement WAL median than baseline; this is evidence of variability, **not** improved index write economics.

## Assessment

The lower INSERT execution medians in later configurations are not causal proof of faster indexed inserts: scenarios ran consecutively in one database, with warming caches, heap churn, rolled-back write effects and possible full-page images/checkpoints. WAL fluctuations (including on unrelated tables) emphasize lack of isolation. Small sample (three), synthetic tenant, no sustained concurrency, no fresh database per configuration. This probe does not establish production p95 throughput or cost.

**Decision:** continue to defer the two candidate index migrations and maintain schema 79. The read benchmark found measurable small-tenant improvements, but large-tenant benefits were inconsistent, while write WAL can increase. Next rigorous test should use independently recreated disposable DBs per scenario with randomized order, repeated measurements, index size plus more representative workload and cold/warm separation.

PR #10 remains draft stacked on PR #7; Stripe TEST ADR-121 external verification pending. No merge, deployment, Stripe LIVE or paid entitlements.
