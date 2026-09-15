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
