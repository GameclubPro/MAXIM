# Finite Publisher turn profile

Use this opt-in native PostgreSQL profile before changing repeated audience reads. It measures
fully awaited public dispatch and maintenance calls, with real SQL selection, leases, final
authorization and receipt persistence. MAX sending, exact-message presence, heartbeat and Redis
health are synthetic. It is not a Redis, MAX quota, HTTP or production acceptance test.

```bash
node scripts/agent/with-test-stores.mjs --migrate -- \
  npm run test:publisher-full-turn-profile --workspace @maxim/api -- \
  --smoke --output /absolute/private/new-smoke.json

node scripts/agent/with-test-stores.mjs --migrate -- \
  npm run test:publisher-full-turn-profile --workspace @maxim/api -- \
  --rollup-noop-mode off --output /absolute/private/new-full-profile-off.json

node scripts/agent/with-test-stores.mjs --migrate -- \
  npm run test:publisher-full-turn-profile --workspace @maxim/api -- \
  --rollup-noop-mode 100 --output /absolute/private/new-full-profile-100.json
```

The output must be new. Keep reports outside Git. The public command owns `api-validation`,
code generation and TypeScript validation. It rejects non-loopback databases, databases outside
the disposable `maxim_race_test_*` namespace, connection query overrides and non-UTC execution.
The exact `?schema=public` suffix from the store wrapper is supported. There is no missing-store
skip. Default Jest discovery excludes `.profile.ts`; ordinary CI does not seed large audiences.

The smoke runs the seven 64-recipient cells. Both modes first calibrate driver row counts and
check final revocation, cancellation, independent progress after denied recipients, verification,
persisted blockers and targeted dispatch on small fixtures. The full matrix has 24 cells, each
with one warm-up and three measured calls (96 calls, 72 measurements):

| State                                           | Audience             | Public calls                                   |
| ----------------------------------------------- | -------------------- | ---------------------------------------------- |
| Ready text NOW                                  | 64 / 10,000 / 50,000 | Global NOW, maintenance run, maintenance pause |
| Future retry only                               | 64 / 10,000 / 50,000 | Global NOW, maintenance run, maintenance pause |
| Mostly SENT, 50 due verifications               | 50,000               | Global NOW, maintenance run, maintenance pause |
| Four persisted blockers before ready recipients | 50,000               | Global NOW                                     |
| Ready targeted control                          | 50,000               | Targeted NOW                                   |
| Due scheduled text                              | 64                   | Global deadline                                |

Temporal selection mode is explicitly `off`. The independent occurrence rollup no-op mode is
`off` by default; `--rollup-noop-mode` accepts only `off` or `100`. The runner overrides ambient
rollout variables, passes the chosen mode to every runtime's `ConfigService`, and records both
modes in the report configuration, including failures before the profile starts. Compare the
same 24 cells in separate `off` and `100` runs; neither mode changes the synthetic boundaries,
quotas or dispatch quantum. These local choices do not activate the production feature.

Fixtures include all snapshot targets, grants, bindings,
calendar reservations and deliveries. Seed, reset, plans, postconditions and cleanup are outside
the timed operation, in batches of at most 1,000 audience IDs. Only one fixture exists at once.
This measures pre-materialized work, not audience materialization or a full 50,000-recipient drain.
Maintenance performs SQL work and must not send or remotely verify messages.

The report preserves each call, missing/failed cells, postconditions, source digests and machine
context. Compare medians and ranges for equal cells and actual work counts. Three repetitions
do not support production p95/p99 claims. Driver instrumentation preserves adapter and transaction
contracts. A guarded single active scope supplements AsyncLocalStorage because Prisma can invoke
the adapter from an earlier async resource. Overlapping measured operations are rejected.

`adapterCalls` are observed adapter methods, not all SQL statements: internal BEGIN/isolation
and savepoint SQL are not separately counted. Await includes connection/admission waiting.
Returned SQL rows and affected write rows are separate; `deliverySqlRows` covers only calibrated
direct SELECT shapes. A scalar probe returning one row does not establish how many delivery rows
PostgreSQL visited or how much physical SQL work it performed. The separate native query-plan
checks establish those bounds; scalar rows are never added to `deliverySqlRows` as audience
cardinality. Hydrated relation cardinality remains explicitly unknown. Memory is sampled
every 20 ms, including sample count and largest gap; CPU is the Node process, not PostgreSQL.
GC observations can lag the interval. Read-only SELECT plans are replayed after the turn and
ANALYZE on the disposable database, so they do not represent the original exact snapshot.

The runner has a five-minute smoke or 45-minute full deadline, including preparation. It terminates
the owned child process group on failure/timeout and waits for bounded group cleanup before
releasing its lock. It never races active SQL against fixture deletion. A partial report or a
missing cell is not success; completion requires successful fixture and connection teardown.

## Baseline on 17 October 2026

The first full run completed at 16:36:25 UTC against runtime source
`676c0eed3c775a3072d25ef002f93b00dc8c6c00`: 24 cells, 24 warm-ups, 72 measured calls,
seven small controls and the eight-row driver calibration passed. Fixture cleanup and owned
store teardown completed with exit status zero. The profile files were uncommitted and their
individual SHA-256 digests were preserved in the private report. This is a local baseline,
not a production speed or capacity result. A later failure-path cleanup correction passed the
seven-cell native smoke again; the full baseline retains its original source digests.

| Cell                                 | Median ms |        Range ms | Adapter calls | Direct delivery SELECT rows |
| ------------------------------------ | --------: | --------------: | ------------: | --------------------------: |
| ready-64-now                         |     81.16 |     79.53–88.74 |           233 |                         128 |
| ready-64-maintenance-run             |     15.39 |     15.25–16.21 |            47 |                         130 |
| ready-64-maintenance-pause           |      6.79 |       6.70–6.99 |            19 |                          65 |
| future-retry-64-now                  |     20.57 |     20.15–20.87 |            45 |                         128 |
| future-retry-64-maintenance-run      |     15.09 |     15.04–17.20 |            47 |                         130 |
| future-retry-64-maintenance-pause    |      6.63 |       6.57–7.73 |            19 |                          65 |
| ready-10000-now                      |    677.75 |   672.18–716.35 |           233 |                       20000 |
| ready-10000-maintenance-run          |    146.09 |   141.54–148.21 |            47 |                       20002 |
| ready-10000-maintenance-pause        |     68.97 |     68.24–70.24 |            19 |                       10001 |
| future-retry-10000-now               |    674.80 |   667.33–680.69 |            45 |                       20000 |
| future-retry-10000-maintenance-run   |    143.77 |   140.96–149.80 |            47 |                       20002 |
| future-retry-10000-maintenance-pause |     74.03 |     69.58–75.56 |            19 |                       10001 |
| ready-50000-now                      |   3054.28 | 3041.95–3087.34 |           233 |                      100000 |
| ready-50000-maintenance-run          |    666.49 |   662.50–672.31 |            47 |                      100002 |
| ready-50000-maintenance-pause        |    335.92 |   329.73–337.30 |            19 |                       50001 |
| future-retry-50000-now               |   3328.07 | 3284.13–3377.30 |            45 |                      100000 |
| future-retry-50000-maintenance-run   |    669.83 |   653.86–672.32 |            47 |                      100002 |
| future-retry-50000-maintenance-pause |    334.90 |   328.76–335.44 |            19 |                       50001 |
| verification-50000-now               |   3428.87 | 3396.73–3458.82 |           342 |                      100050 |
| verification-50000-maintenance-run   |    868.67 |   859.17–879.89 |            47 |                      100002 |
| verification-50000-maintenance-pause |    455.20 |   453.77–468.48 |            19 |                       50001 |
| blocked-head-50000-now               |   3083.68 | 3078.36–3156.76 |           233 |                      100000 |
| ready-50000-targeted                 |   6152.51 | 6143.93–6167.82 |           462 |                      200000 |
| ready-64-deadline                    |    108.57 |   108.20–112.19 |           233 |                         128 |

The maintenance pass reads the whole delivery set twice (once before a governor pause), even
when all retries are in the future. Additional one-row delivery probes explain counts above
exact audience multiples. The targeted method performs two dispatch quanta, so its 200,000
rows and approximately 6.15 seconds must be compared with its eight sends, not a single
four-recipient global quantum. The verification control performs 50 synthetic presence checks
and no SEND. Maintenance never calls either synthetic external operation.

The follow-up experiment was a positive indexed proof that a saved rollup status would stay unchanged;
terminal, uncertain and verification-only states retain the existing full reader. It addresses
maintenance reads only. It does not establish bounded dispatch/materialization or remove the
separate no-op CAS required by manual resolution.

RSS is the cumulative test-process footprint, including earlier fixtures and JIT state; it is
not allocation per publication. Sampling gaps reached 1.35 seconds, so sampled peaks can miss
short-lived allocations. Runtime warning/error counters cover the dispatch logger only, not
all PublicationService logging. Persisted statuses are recorded, but the profile is not a full
old/new status-equivalence proof; the optimization additionally requires native equivalence
and concurrent-writer cases.

## Historical local comparison of the earlier reader on 18 October 2026

This comparison predates the later occurrence metadata and catalog-admission
corrections. Its figures describe those earlier source bytes and do not validate
the current reader. Repeat both complete matrices against the same frozen corrected
source before release acceptance.

The then-current reader completed matched `off` and `100` full matrices: 24 cells,
96 fully awaited calls per mode, seven controls and the eight-row calibration. Both
wrappers exited zero and removed their owned stores. The 2,524 selected source files
and 11 supplemental execution configurations were frozen before `off`, then verified
after each sequential run. Final completion was 01:55:51 UTC. Observed outcome
projections, counters and action cardinality, uniqueness and order matched; these are
not complete database snapshots. Broad checks, exact-SHA CI and deployment remained
separate unfinished gates at this measurement.

| Ready 50,000-recipient cell | Median off → 100 ms | All returned SQL rows | Direct delivery SELECT rows |
| --------------------------- | ------------------: | --------------------: | --------------------------: |
| Maintenance run             |      622.82 → 13.39 |           100,006 → 4 |                 100,002 → 2 |
| Maintenance pause           |       312.02 → 6.41 |            50,003 → 2 |                  50,001 → 1 |
| Global NOW                  | 3,002.20 → 3,001.66 |     100,077 → 100,077 |           100,000 → 100,000 |

Verification-only keeps the complete reader and adds bounded probes. Returned-row
counts do not establish physical work; separate corrected native tests exercise
retained/skewed history, stale statistics and post-ANALYZE plans. Their physical guards
passed, but successful plan summaries were suppressed, so exact observed maxima are
not available. The 169 passing tests across three suites include pure plan-validator
cases alongside actual PostgreSQL integration. The old latency suite passed 7/7 both
before and after on the same disposable store environment; this does not by itself
establish real BullMQ behavior.

No cell's elapsed-time local median or observed maximum increased by more than 10%; the largest
median increase was 5.01% for the unchanged ready-10k NOW path. Three measurements
are descriptive, not production p95/p99 or statistical acceptance. The earlier
small-deadline outlier remains retained evidence; it did not recur in this final
matrix, and its original cause remains unproved.

Ready-50k maintenance Node CPU median was 655.3 → 7.0 ms. NOW remained around
3.65 seconds of Node CPU. Median per-turn maximum event-loop delay was
1.143 → 1.147 seconds; the observed maximum was 1.192 → 1.147 seconds. This
supports the next bounded-recipient stage, not a NOW speedup claim.
Short optimized maintenance calls have missing histogram samples, not zero delay.
GC measurements varied: future-retry-10k NOW median was 36.64 → 52.04 ms, and
targeted median was 349.81 → 394.87 ms; elapsed-time equivalence is not a guarantee
that every resource counter improved. RSS is cumulative and sample gaps exceed one second in the unchanged large paths;
there is no proved per-operation memory reduction or exact peak. The profile uses
native PostgreSQL with synthetic MAX/Redis/readiness boundaries. Initial production
release keeps the independent shortcut off and proves compatibility only.

## Final-current matched profile on 18 October 2026

The corrected OFF4/1004 pair completed at 03:55:45 UTC. Each mode passed all 24 cells,
96 calls, seven controls and the eight-row calibration. Both public store wrappers
exited zero and removed their owned stores. The 2,524 selected source files and 11
supplemental execution configs matched before and after both modes. Outcome
projections, business counters and action cardinality, uniqueness and order matched;
these are not complete database snapshots. Native validation separately passed 177
tests across three suites, including pure validators and actual PostgreSQL cases,
with latency 7/7 before and after; real BullMQ and MAX remain outside this profile.

| Cell                                  | Median off → 100 ms | All returned SQL rows | Direct delivery SELECT rows |
| ------------------------------------- | ------------------: | --------------------: | --------------------------: |
| Ready 50k maintenance run             |      605.57 → 12.56 |            100006 → 4 |                  100002 → 2 |
| Ready 50k maintenance pause           |       309.26 → 6.53 |             50003 → 2 |                   50001 → 1 |
| Ready 50k global NOW                  |   2937.82 → 2903.85 |       100077 → 100077 |             100000 → 100000 |
| Ready 50k targeted                    |   5857.47 → 5862.99 |       200152 → 200152 |             200000 → 200000 |
| Verification-only 50k maintenance run |     898.65 → 852.61 |       100006 → 100008 |             100002 → 100002 |
| Due scheduled 64                      |       76.62 → 90.50 |             205 → 205 |                   128 → 128 |

The scheduled-64 median increased 18.12%, with observed maximum 78.88 → 92.50 ms
(+17.27%). Its SQL/action work was equal; the cause is unproved. These descriptive
flags remain open before feature activation; do not discard them or infer a
production percentile from three observations. No other cell crossed either local
10% timing flag. The first deployment remains off and proves compatibility only.

Ready-50k maintenance Node CPU median was 639.24 → 6.64 ms; NOW stayed
3579.25 → 3562.83 ms with per-turn event-loop maximum medians 1137.70 → 1108.34 ms.
Optimized short maintenance calls have no histogram samples, not zero delay. RSS
is cumulative and periodic sampling gaps remain; no exact peak, isolated allocation
reduction or leak result follows. Physical query-plan evidence is separate from
returned rows. The retained same-key MVCC failure prevents a universal heap-fetch
bound; fresh/positive-stale native witnesses use distinct keys and unchanged limits.
