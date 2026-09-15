# Webhook Expansion Stalls - 2026-09-15

## Evidence

A Publik forward-import report prompted a read-only queue investigation. Ingress readiness
reported a RECEIVED backlog older than eight minutes while PostgreSQL and Redis remained
reachable. A screenshot alone does not identify the affected receipt or establish the exact
cause of that user's import failure.

The api-enqueue logs repeatedly recorded normal-mode batches spending 298-446 seconds in
prioritization with only 6-20 selected work units. Selection and enqueue itself took less than
a second in those batches. Degraded-mode batches skipped optional chat expansion and resumed
processing; the stall returned after recovery to normal mode.

The optional selected-chat query applied eligibility filters and global chronological ordering
over a multi-chat IN predicate before LIMIT. That final LIMIT bounded returned rows, not the
database work. No statement timeout protected this optional query.

## Correction

1. Select exact chat heads through the existing webhook_events_ordered_chat_head_idx and
   per-chat lateral index probes. Materialize the bounded heads before eligibility checks.
2. Cap each chat at 16 heads and divide the existing selection-window budget across selected
   chats. Preserve already-selected candidates even when expansion produces no eligible rows.
3. Run expansion with a transaction-local one-second PostgreSQL statement timeout, a one-second
   connection acquisition budget, and a two-second transaction timeout. The existing failure
   path continues with selected heads after rollback.

Ordered-head rechecks, activation CAS, retry eligibility, detached-timeout quarantine, and
semantic duplicate fencing remain unchanged. No pending receipts, BullMQ jobs, or historical
quarantined failures are deleted or reset. No schema migration or increased concurrency is
required.

## Verification

- Focused queue and Publik import suites passed: 136 tests.
- PostgreSQL 16 tests passed against a disposable, fully migrated local database: 4 tests.
- A 4,000-message chat fixture verifies the per-chat cap, indexed EXPLAIN plan, retained peer
  progress, and filtering after the bounded head window.
- An exclusive table lock verifies actual PostgreSQL cancellation and connection recovery.

Deployment requires green exact-SHA CI and the complete shared API role rollout. Observe at
least two normal/degraded recovery cycles or a continuous healthy window after rollout before
attributing the queue recovery to the correction. Revisit the Publik report after queue health
is stable; do not publish or delete real user content as a diagnostic shortcut.

## Rollout And Follow-Up

Runtime commit `0aaf72696523a40a0b9871cfc8eab0aa20a70993` passed the exact-SHA Required and
CodeQL checks. Local API validation passed 11,997 tests, typechecking, and build, in addition
to the four explicit PostgreSQL tests. The immutable CI API image was preloaded because VPS
disk utilization exceeded the local-build percentage guard. No guard was bypassed.

Release `release-20260915T080733Z-0aaf72696523` updated all 13 API roles and the OCR auxiliary.
Strict ingress/admin readiness, public liveness, and isolated OCR smokes passed after the
existing backlog drained. Postgres, Redis, and both active static components were not recreated.

Completed local capacity archives recorded these post-rollout windows (UTC):

| Window            | Samples | Median lag |  p95 lag | Maximum lag | Failed readiness samples |
| ----------------- | ------: | ---------: | -------: | ----------: | -----------------------: |
| 08:22:47-08:27:47 |      20 |    0.672 s | 26.695 s |    27.150 s |                        2 |
| 08:29:22-08:35:22 |      24 |    0.538 s |  3.735 s |    11.777 s |                        0 |

Both windows had complete sampling coverage, exact API image/topology parity, released queue
fences, and zero restarts. These are sampled oldest-event ages, not request latency percentiles.
Short lag spikes remain; do not describe this as an entirely spike-free runtime. The system
was still in automatic stabilization at the second window's end, so these windows alone do not
prove sustained normal-mode behavior. The bounded expansion and database-side cancellation
were verified directly by the PostgreSQL tests.

The follow-up import/router suites passed 62 tests. The observed publisher-post-import queue
had zero waiting, active, delayed, or failed jobs. No user content was sent, modified, or deleted.
The original screenshot still lacks an actor/receipt identity and send time; a fresh reproduction
with that context is required to conclusively attribute or investigate that user's remaining
forward-import failure.
