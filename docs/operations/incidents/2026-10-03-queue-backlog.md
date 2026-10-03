# Queue backlog on 3 October 2026

## Conclusion and scope

The incident was a chain of internal scheduling and database-selection defects. Webhook
receipts continued arriving while preparation admission, outbox polling and recovery did
less useful work than their apparent capacity allowed. Expensive delete-intent selection
added database work. No evidence establishes a MAX-wide outage, Redis data loss, or a need
to increase worker concurrency as the cause.

Eight defects were reproduced and corrected in PRs [44](https://github.com/GameclubPro/MAXIM/pull/44)
through [51](https://github.com/GameclubPro/MAXIM/pull/51). The share of total delay attributable
to each defect was not measured independently. Some were exposed during the priority
refactoring; others were existing query/recovery defects encountered under retained history
and live load. Do not attribute every defect to one change or claim an end-to-end 100-fold speedup.

This review covers the queue incident and the agent's response through **18:37 Moscow time
(15:37 UTC)**. It is an incident record, not the authoritative current rollout state.
The backlog was drained; the fresh Publisher acceptance window was still pending.

## Impact and recovery evidence

- The largest observed oldest-queue age was **11,823.31 seconds (3 h 17 min)** at
  13:58:16 Moscow time (10:58:16 UTC). This is sampled oldest age, not every user's delay.
- Bounded queue audits repeatedly found at least 2,000 RECEIVED rows. Saturation prevented
  an exact backlog count. At least 2,000 historical FAILED quarantine rows were a separate
  retained population, not 2,000 new failures.
- Ingress continued accepting work. In the complete 16:16–17:16 Moscow interval
  (13:16–14:16 UTC), all 360 ten-second buckets contained 59,583 accepted/persisted receipts,
  with no recorded ingress failure or timeout. Receipts include duplicate deliveries.
- At 17:29:46 Moscow time (14:29:46 UTC), raw readiness recovered and lag was 0.248 seconds.
  The 17:30 bounded SQL audit found seven fresh RECEIVED rows and no QUEUED rows.
- At 18:34 Moscow time (15:34 UTC), another audit found one fresh RECEIVED row, age zero,
  no QUEUED rows and no ordering predecessor. The subsequent lag sample was zero.
- No queue or send ledger was deleted to achieve recovery. Permission, ordering, ambiguous-send,
  concurrency and timeout fences remained in place.

## Confirmed defects

| Defect                                                                                     | Evidence                                                                                                                                                | Correction                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle admission retained an already-consumed next-slot reservation                     | Three local regressions showed ordinary work rejected despite free capacity after lifecycle admission                                                   | PR44 consumes that reservation on admission, without clearing a newer reservation on completion                                                      |
| Historical FAILED timeout recovery performed expensive eligibility probes before its limit | Recovery selections had a 5.9 s median versus 28 ms without that recovery; a query exceeding the five-second interval immediately became eligible again | PR45 limits the raw retained source to 200 rows before probes, keeps due retries independent and starts cooldown after completion, including failure |
| A bot already at its lifecycle quota reserved unrelated global capacity                    | Two regressions reproduced the unusable reservation with free or subsequently released global slots                                                     | PR46 reserves a global slot only when the requesting bot can use it                                                                                  |
| Outbox dispatched work into known-busy preparation slots                                   | A bounded fixture produced unnecessary deferrals for seven of eight independent events                                                                  | PR47 checks existing admission availability and reuses released slots within the existing dispatch bound                                             |
| Fixed polling intervals added idle time after long batches                                 | A 450 ms batch with a 200 ms interval waited until 600 ms to restart                                                                                    | PR48 rearms after drain, subtracts elapsed time and yields before an overdue next poll                                                               |
| Delete-intent selection mixed statuses before ordering and limiting                        | Live completed selections averaged about 15.7 s; a 50,000-row PostgreSQL fixture scanned the full eligible source to return 100 rows                    | PR49 uses bounded indexed prefixes per status and preserves the original total limit, ordering, leases and guards                                    |
| An expired duplicate replay waited for an obsolete initial admission                       | Two regressions reproduced incomplete-admission failures after either action deadline had expired                                                       | PR50 applies the wait only while the deadline is open; existing Redis terminal settlement remains authoritative                                      |
| Correlated reason checks became repeated full reason-table scans                           | PostgreSQL showed 30 scans of 200,000 reason rows; the smaller regression visited 1.5 million reason rows for 100 intents                               | PR51 preserves indexed correlation with OFFSET 0, without changing predicates, schema or authority                                                   |

The final SQL correction has the clearest measured local effect: 190 completed selections in
14:13–14:38 Moscow time (11:13–11:38 UTC) averaged 7,383 ms. After PR51, 180 completed selections
in one runtime epoch at 15:17:27–15:20:27 Moscow time (12:17:27–12:20:27 UTC) averaged 73.92 ms,
with zero selection errors. This measures that query, not total webhook throughput.

## Timeline and release semantics

All times below are Moscow time; UTC is included for correlation with machine evidence.

| Moscow / UTC              | Event and interpretation                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 03:31 / 00:31             | New v3-instrumented warmup after the metric correction; old v2 windows cannot receive acceptance credit                                                                      |
| 06:28 / 03:28             | PR44 guarded release completed, but subsequent raw readiness/queue lag remained unhealthy                                                                                    |
| 07:13 / 04:13             | Slow retained-timeout selections observed; the first repair had not removed all bottlenecks                                                                                  |
| 08:38–08:56 / 05:38–05:56 | PR45 runtime transition reached exact images and resumed queues, then failed the 900-second readiness deadline                                                               |
| 09:35–09:53 / 06:35–06:53 | PR46 transition also failed readiness; no current committed release manifest                                                                                                 |
| Morning and afternoon     | PR47–50 corrected dispatch, polling, delete selection and expired duplicate admission; useful local corrections did not establish a successful release or healthy throughput |
| 15:12–15:31 / 12:12–12:31 | PR51 transition resumed queues at 15:15:39; SQL accelerated, but accumulated backlog still exceeded the readiness deadline                                                   |
| 17:29 / 14:29             | Accumulated backlog drained and raw readiness recovered                                                                                                                      |
| 17:38 / 14:38             | First finalization failed; an OCR native timeout/recycle occurred in that interval. The exact finalizer error was not retained, so causation remains unproven                |
| 17:47 / 14:47             | Standard finalizer passed all fences and API/static/OCR smokes and committed the release without recreating containers                                                       |
| 17:52 / 14:52             | New homogeneous v3 warmup began; historic and transition intervals received no acceptance credit                                                                             |

The committed recovery release is `release-finalized-20261003T144707Z-742bcd2b5976-2218703`,
API SHA `742bcd2b5976c294eaf9b15b1a61ad425d48d639`. All 14 API roles were attested exact/running
in canary; Publisher identity and dispatch checks passed. This records recovery, not promotion to `on`.

## What worked

- Meaningful regressions failed before corrections. Real PostgreSQL fixtures exposed query-plan
  work hidden by small/mocked datasets; Redis tests exercised duplicate admission and settlement.
- Exact-source/main Required and CodeQL checks, image preload and guarded wrappers were retained.
  Disk floors, queue fences and all-role image parity were not relaxed under pressure.
- Failed deployments were recorded as failures even after container recreation and queue resume.
  The current manifest was restored only through the standard finalizer after strict checks.
- Read-only catalog queries, bounded log classification and aggregate counters preserved evidence
  without storing content, identifiers, credentials or raw production logs.
- Once corrected processing could drain the backlog, another runtime recreation was unnecessary.

## What slowed diagnosis and recovery

1. **A visible preparation-capacity marker was initially too narrow an explanation.** It was the
   last stored deferral, not the entire queue's cause. Earlier comparison of selection, preparation,
   ordered-head, retry and action stages would have exposed the coupled SQL problem sooner.
2. **Correctness tests did not initially bound database work on retained history.** LIMIT on results
   did not bound correlated probes, sorting or repeated reason scans. Representative PostgreSQL
   EXPLAIN ANALYZE/BUFFERS fixtures belong before deployment for hot-path selection changes.
3. **Several valid fixes were deployed incrementally while older causes remained.** Each runtime
   wave paused/drained/restarted the shared fleet and added transition backlog. Individual fixes
   were necessary, but green unit tests or faster sampled batches did not prove useful throughput
   exceeded incoming load. Avoid retrying the same failed rollout without a changed, evidenced basis.
4. **Telemetry had important blind spots.** PR42 corrected omitted urgent lifecycle/connection/bot-expiry
   work; PR43 separated actual capacity deferrals from other preparation failures. Rate-limited
   outbox logs were not a complete latency distribution. Repeated hourly reports needed replacement,
   not summation. A successful HTTP 200 could mask raw readiness failure through hysteresis.
5. **One diagnostic wrapper lost the finalizer error.** Another shell-over-stdin probe stopped early
   when a child command consumed stdin. Exit zero without every expected stage was incomplete evidence.
   Preserve allowlisted failure stage/code and make stage completion explicit.
6. **Local stores were assembled temporarily.** A working Node installation alone did not guarantee
   PostgreSQL/Redis integration coverage. Missing test URLs skipped hundreds of store-dependent cases
   in one full API run; the targeted real-store cases were run separately. Report passed and skipped
   counts together, and keep an easy isolated native-store path available when Docker is unavailable.
7. **Operational state mixed historical and current fields.** Old canary timestamps and old correction
   statuses survived recovery. Read the current phase/release/boundaries explicitly; keep history
   separate and document evidence limits instead of treating every saved field as current truth.

## Remaining observations, not established causes

- Short lag spikes reached 12.31 seconds around 17:42 Moscow time and 11.237 seconds at 18:07
  (14:42 and 15:07 UTC), then recovered. No persistent ordered-head cause was established.
- The 17:30–18:30 Moscow capacity report contained only 116 samples and a 124.55-second gap;
  it was degraded and insufficient. It cannot become a successful acceptance hour.
- In 18:10–18:15 Moscow time, one initial actor refresh was nominated 85.635 seconds after its
  urgency boundary and started 0.158 seconds later. Late nomination is established; its eligibility
  or producer cause is not. Changing permissions or retrying sends would not follow from this evidence.
- HTTP 403/404 outcomes, background internal limiter rejections, I/O pressure and an autovacuum
  snapshot were retained as observations. Neither isolated failures nor aggregate stack RPS prove
  an external outage, a per-bot capacity limit, or that cancelling maintenance would help.
- OCR's one recorded restart followed a `native_timeout`. All 14 actual API roles had restart
  counters zero. The fleet total included the auxiliary; it was not an API crash count.
- At the review boundary, all warmup cursor cycles had been observed, but initial urgent attempts
  numbered only 426 and histogram p95/p99 bounds were 15/60 seconds, above the 5/15-second gates.
  Full exact obligations, terminal windows and 24-hour acceptance remained outstanding.

## Applied prevention and follow-up

- Runtime corrections and their regression coverage are in PR44–51; no new speculative runtime
  change is part of this review.
- [The incident playbook](../../incident-playbook.md) now describes evidence ordering, raw readiness,
  ownership, incomplete diagnostics and release recovery.
- [Local agent setup](../../development/agent-local-environment.md) documents a doctor and disposable
  native PostgreSQL/Redis runner. The runner replaces inherited data-store URLs, uses UTC, and cleans
  up only the processes and directory it creates.
- Root and scoped AGENTS notes contain the durable commands and verification rules. Historical
  findings stay here, not in active agent instructions.
- Continue narrow investigation of the residual queue/nomination observations during acceptance.
  Only then complete the fresh full canary, guarded `on` rollout and subsequent configured-bot audit.
  The operator-paused automation is not resumed by this documentation/tooling change.
