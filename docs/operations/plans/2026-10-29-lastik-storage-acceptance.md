# Lastik storage measurements and acceptance — 29 October 2026

The operating target is 20,000 chats and up to 6 million deletions/day. One bot
remains the current deployment. At 20 HTTP requests/second, its absolute ceiling
is 1,728,000 requests/day, before reads, rights, pins, retries and safety scans.
Six million DELETE requests alone require 69.45 requests/second. This workload
must fail capacity admission under the current limit; accepting webhooks is a
different capacity claim from completing all deletions.

## Reproducible isolated measurements

Run each command separately on disposable PostgreSQL 16 and Redis 7. The helpers
accept only the loopback database created by the public test-store wrapper, create
their own schema, and contact no MAX endpoint. Output contains numeric synthetic
measurements, no production messages or credentials.

```bash
node scripts/agent/with-test-stores.mjs -- \
  node --import tsx apps/eraser/test/support/storage-benchmark.mjs
node scripts/agent/with-test-stores.mjs -- \
  node --import tsx apps/eraser/test/support/ingestion-benchmark.mjs
```

The 29 October sample seeded 20,000 idle policies, 100,000 terminal candidates and
200,000 receipts. Candidate table plus indexes occupied 27,828,224 bytes; receipts
occupied 73,973,760 bytes; policies occupied 8,093,696 bytes. Seeding generated
160,501,136 WAL bytes. Adaptive purge passes removed 500/1,000, 1,000/2,000,
2,000/4,000, 4,000/8,000 and 8,000/16,000 candidate/receipt rows, taking approximately
11, 14, 25, 46 and 80 ms respectively. Empty 20,000-policy reservation took
0.33–1.22 ms. This is a small local sample, not a seven-day production measurement;
bloat, vacuum, replication and concurrent load are not represented.

Four ingestion clients processed 11,000 synthetic events per profile: five fresh
creations, five absent-candidate removals and one edit per eleven events. Uniform
traffic took 6.95 seconds (p95 3.71 ms, p99 5.49 ms); the profile concentrating 80%
of events in 1% of chats took 7.00 seconds (p95 3.67 ms, p99 5.27 ms). WAL was
approximately 5.9 MB/profile; process RSS was approximately 238 MB. These are
database-operation latencies, not HTTP ingress or deletion-age latencies.

At seven days the target workload implies up to 42 million terminal candidates
and 84 million creation/removal receipts, before edits. Simple sample scaling
suggests about 11.7 GB and 31.1 GB respectively for tables plus indexes, excluding
bloat, WAL, backups and replica overhead. Use measured steady-state sizes before
provisioning; these extrapolations are not capacity acceptance.

## Runtime and sustained maintenance samples

The additional runtime probes used the actual Store, CleanupRuntime, MaxClient,
PostgreSQL, Redis and shared 20-request/second gate. The MAX HTTP function was replaced
with an in-memory synthetic endpoint; no requests reached MAX. Each database contained
20,000 policies. These probes supplied already-due late message events, with deletion
receipts and occasional edits. They measure this discovery path, not natural 24-hour
webhook maturation or real network latency. The protected-message and uncertain-effect
cases remain covered separately by the native regression suite.

| Profile                                       | Duration | Arrivals | Deletes | Remaining |
| --------------------------------------------- | -------: | -------: | ------: | --------: |
| Idle, next safety scan in the future          |     20 s |        0 |       0 |         0 |
| Uniform target 6 million/day                  |     60 s |    4,166 |     290 |     3,876 |
| 1% of chats receive 80%                       |     60 s |    4,165 |     356 |     3,809 |
| Target traffic plus 1,000 historical messages |     60 s |    5,166 |     289 |     4,877 |
| Fivefold target peak                          |    900 s |  312,491 |   7,965 |   304,526 |
| 2 messages/s with 20-second Retry-After       |     70 s |      139 |     108 |        31 |
| 2 messages/s                                  |    180 s |      359 |     358 |         1 |

No probe issued a duplicate DELETE. The idle probe made zero HTTP requests, but does
not measure a complete safety-scan cycle. The skew probe served 186 quiet chats and
51 hot chats; this demonstrates independent progress, not a fleet fairness percentile.
The history probe removed eight historical messages and 281 current messages. The
cooldown probe resumed after its refusal; its remaining queue is explicit, not counted
as drained. At 2 messages/s, completed-message delay was p95 1.36 s and p99 1.57 s;
the single remaining message was 715 ms old when observation ended. Short local runs
do not establish a production SLA or measured sustainable MAX capacity.

The fifteen-minute peak used 14,276 HTTP requests, 367,224,696 WAL bytes and at most
421,658,624 process RSS bytes. Useful DELETE/request was 0.558 (0.246 in the uniform
probe). Only 2,045 distinct chats received deletions during the overloaded peak; the
oldest remaining message was about fifteen minutes overdue. Completed-only latency
quantiles must never hide that remaining work. Both target and peak fail capacity
admission with the current single-token limit.

A separate five-minute PostgreSQL maintenance sample fed expired terminal candidates
at 6 million/day and receipts at 12 million/day, retaining the actual 30-second cadence.
Starting backlog was 21,000/42,000 rows; 20,831/41,662 arrived during the sample and
41,251/82,502 were purged. The final backlog was 580/1,160. All 1,000 unknown journals
and 100,000 recent candidates remained. Maintenance generated about 35.8 MB WAL and
used about 95.7 MB process RSS. This confirms catch-up within this isolated sample;
large-table vacuum, shared host pressure and multi-day growth remain separate gates.

## Safety and recovery evidence

Native regressions cover indexed page work beside retained history, skip-locked
progress, seven-day retention, preservation of all unknown/manual journals,
adaptive finite budgets, stale observations after query failure and continued
dispatch after a maintenance failure. The schema is unchanged by this stage.

A real isolated pg_dump/pg_restore rehearsal preserves three issued/manual
journals, protected messages, the future schedule and durable cooldown, and rebuilds
a fresh Redis queue with one permitted fake deletion. Changed migration digests
and missing critical indexes fail the restore check. Separate backup-script tests
exercise both profiles, real age encryption, complete ciphertext readback, corrupt
objects, foreign checksums, missing Lastik readiness and invalid restored schema.
Mocked Docker/S3 command tests do not establish production recovery.

## Gates that remain separate from implementation

1. Exact-SHA Required and CodeQL, guarded Lastik deployment, immutable manifest,
   original store identities and a live worker/maintenance readback.
2. Lastik's own encrypted independent copy with complete readback and isolated
   production-archive restore. Rehearse a downloaded/decrypted independent copy
   with the off-host key. Do not enable recurring timers before freshness health passes.
3. Extend the sampled profiles to sustained natural expiry, a complete safety-scan
   cycle and Redis/PostgreSQL outage/recovery during load. Existing native regressions
   establish bounded failure/restart safety; the samples above do not establish
   sustained fleet performance or multi-day vacuum/bloat behavior.
4. Measure useful DELETE/HTTP, eligibility delay, per-chat fairness, query cost,
   RSS, WAL, vacuum and table growth. At no more than 70% of **measured** sustainable
   capacity, require p95 eligibility delay ≤5 minutes, p99 ≤15 minutes and no
   sustained backlog growth. Keep unknown and protected-history ages separate.
5. Start the final continuous 24-hour window only after preceding gates. Record
   releases, gaps and failed samples; a corrective release restarts acceptance.
   Natural 48/168-hour expiry requires specifically created messages in an explicitly
   verified isolated test destination. No diagnostics or test publications in user chats.

Neither the local samples nor a healthy release readback proves six million daily
deletions, complete historical protection or final production acceptance.
