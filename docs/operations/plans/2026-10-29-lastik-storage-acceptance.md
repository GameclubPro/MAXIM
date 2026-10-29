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
3. Sustained isolated mixed-workload runs: 20,000 idle chats; uniform 300 messages
   per chat/day; 1% producing 80%; fivefold peak for 15 minutes; history alongside
   current messages; long 429 and Redis/PostgreSQL outage/recovery. Existing native
   regressions establish small-case safety, not sustained fleet performance.
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
