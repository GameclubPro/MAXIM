# Bounded outbox traversal

Webhook enqueue selection keeps the recent-receipt reserve and exact per-chat ordered-head
check before CAS. The older receipt, failed, stale user-facing queued and stale background queued
lanes each split their existing raw scan allowance equally between an oldest head pool and a
rotating keyset page. Normal mode retains 5,000 raw rows per lane, degraded mode 1,000 (or the
existing larger configured selection window). The recent-receipt lane retains its original pool.
No OFFSET, new global JSON scan, routing move, new queue or migration is introduced.

Each rotating lane uses `(created_at, id)` and a creation-time horizon fixed when the cycle begins.
Newer arrivals cannot keep extending that cycle. Short pages wrap; an empty page also completes
the cycle. Rows that become due behind the cursor are revisited after wrap. The cursor advances
across the raw page tail, rather than its single collapsed hot-chat representative. If the distinct
candidate limit is reached, it advances only through the raw prefix preceding the first unreturned
work unit. This avoids skipping capped independent units or walking one repeated chat row per poll.

Cursor updates follow successful completion of the SQL statement. Four in-memory lane cursors
are the only additional retained state. They are selection hints, not receipts or delivery state;
restart repeats scans and the existing durable outbox remains authoritative. A failed SQL statement
does not advance the cursors. Paused repair lanes keep their cursor and resume inside the existing
recovery allowance. Cursor metadata never grants permissions or bypasses timeout quarantine.

A quarter of each existing backlog/recovery selection allowance is reserved for rotating-scan
candidates, including the final priority selection. Recent receipts retain their separate reserve;
age and membership-leave reserves, BullMQ priority, and exact-head/routing fences remain in place.
A blocked earlier message still prevents later messages of that same chat from being enqueued.
Selection is not proof of delivery, and the number of cycles required depends on backlog and budget.

The original SQL failed both real PostgreSQL fixtures: 6,000 hot-chat rows before and after an
independent receipt in normal mode, and 1,200 on either side in degraded mode. The independent
receipt was absent across eight passes while the tail grew. Revised tests cover those cases across
received, failed and both queued lanes, including a one-event admission budget. Additional real
PostgreSQL coverage exercises capped distinct pages, cursor loss, SQL failure, exact ordered heads,
retained timeout quarantine and completed-claim repair. Disposable EXPLAIN ANALYZE confirms bounded
page output and indexed source scans in the burst fixture; production must use plain EXPLAIN only.
These fixtures establish algorithm behavior, not an SLA for arbitrary overload.

Deploy as part of the shared API image through exact-SHA CI and the guarded wrapper. Compare
oldest eligible receipt progress, enqueue/queue latency, database activity, recovery progress and
moderation errors under comparable traffic. Existing queue counts alone do not prove full coverage.
Rollback loses only cursor hints and repeats the old bounded selection; receipts, semantic claims,
MAX send identities and routing fences must never be cleared to repair backlog.
