# PostgreSQL Capacity And Membership Queue Backlog - 2026-09-02

## Status

Resolved at runtime. The VPS was expanded from 6 vCPU / 12 GiB RAM to 8 vCPU / 24 GiB RAM with a
300 GB system disk, and the durable queues drained without deleting or reordering work. The capacity
increase restored headroom; the corrective release removes the application-level amplifiers that
made the incident recur.

## Impact

- The durable webhook outbox reached the 2,000-row bounded audit cap for `RECEIVED` work. The same
  samples still had up to 30 `QUEUED` rows and hundreds of pending BullMQ jobs.
- The authoritative lightweight burst tracker recorded queue-lag peaks up to 307.286 seconds.
  Readiness returned 503 after sustained or severe breaches and background work degraded or paused.
- PostgreSQL connection acquisition timed out across ingress, enqueue, moderation, action,
  Publisher, and admin paths. Some webhook receipt attempts correctly requested MAX redelivery.
- No webhook row, BullMQ job, action intent, Redis state, or database record was cleared as a
  recovery shortcut.

## Evidence

The retained read-only monitor samples showed a coupled capacity failure rather than one stuck
worker:

- A deduplicated scan found 567 membership-cache publications exceeding their 100 ms wait budget:
  397 after `user_added` and 170 after `user_removed` updates.
- One bounded 15-minute metrics window contained 14,229 persisted receipts. Of 1,473 membership-edge
  calls, 1,468 were database no-ops, but the path still attempted 2,939 Redis/Lua cache mutations and
  857 publications exceeded the wait budget.
- During the largest observed pre-resize pressure window, host load reached 13.24 on 6 vCPU, swap
  usage reached approximately 2.85 GiB, and PostgreSQL consumed up to 301% CPU.
- Redis remained below memory capacity with no evictions or rejected connections, but rate-limit
  and membership-cache commands timed out while it was handling roughly 3,900-6,400 operations per
  second. Redis latency was therefore an effect and amplifier, not an eviction/OOM event.
- MAX action traffic continued to make progress and later returned to all-success samples. The main
  accumulation was upstream in durable `RECEIVED` work, so simply adding moderation consumers would
  not have removed the bottleneck.
- The old full queue snapshot emitted governor lag values as high as 1,329.1 seconds while the
  lightweight readiness path observed much smaller current lag. That snapshot ran counts, JSON
  filters, auxiliary queues, and per-bot fanout before calculating its final age, so it was too slow
  and internally stale to drive an operational feedback loop.

## Timeline

All times are UTC.

- `00:40`: the first retained membership-cache publication exceeded its 100 ms wait budget. The
  deduplicated warning series continued through `15:05` and peaked at 44 events/minute.
- `03:17`: the lightweight burst tracker recorded a 305.114-second lag peak; it recovered at
  `03:34`.
- `06:56-07:26`: the bounded audit observed `RECEIVED` grow from zero to 1,702 and then reach the
  2,000-row cap. `QUEUED` rose to 30 and recent `FAILED` rows reached 116. The exact `RECEIVED` peak
  is unknown because the safety cap was reached.
- `14:43`: the largest authoritative lag peak, 307.286 seconds, was recorded.
- `17:19`: a later burst reached 150.547 seconds and recovered at `17:41`.
- `17:39`: the first retained post-resize sample already showed current lag near 0.1-0.3 seconds
  while automatic mode completed its recovery window. From `17:42` mode was `normal`; at
  `18:05-18:06` lag was 0-0.097 seconds with only ordinary transient incoming work.

## Root Cause

A burst of membership updates drove ingress above the sustainable throughput of the shared
PostgreSQL/Redis path on the former 6 vCPU / 12 GiB host. Each committed membership transition also
started cache invalidation/publication work. Once those Redis operations exceeded the 100 ms webhook
budget, the work continued detached without a global in-flight bound or a durable retry result.

The pressure was amplified by runtime governors and moderation fallback checks calling the full
diagnostic queue snapshot. That snapshot issued whole-status counts, JSON-filtered reads, per-bot
queries, and broad BullMQ fanout from multiple API roles. Under database pressure it became slower,
reported stale age, and consumed more of the same connection and I/O capacity needed to drain the
outbox.

Publisher background work also lacked the host-pressure governor settings already used by the other
background owners. Capacity signals were available only in transient, heavy monitor output, so the
team could not reliably distinguish a short burst from sustained CPU, memory, swap, or disk pressure
without rerunning diagnostics.

## Contributing Factors

1. The 100 ms membership-cache budget limited request waiting time, but did not limit detached work
   or turn timeout/failure into a durable deferred preparation outcome.
2. Operational control and closed-dashboard diagnostics shared one expensive snapshot instead of
   separate cost budgets.
3. The former host had little margin once PostgreSQL, Redis, and thirteen API roles competed during
   a burst; active swap made latency more variable.
4. The governor reason mixed queue and MAX API text without a structured condition, making automated
   incident classification and recovery-state observation ambiguous.
5. The load harness measured ACK latency but did not fail a run that undershot requested RPS, and it
   did not prove that asynchronous queues returned to their pre-test pressure.

## Ruled Out

- Webhook subscription loss and a MAX transport outage: all six required bot subscriptions were
  present, public live health stayed available, and action traffic continued to complete.
- A paused or abandoned BullMQ queue: the queue fence was unpaused and unowned, new jobs continued
  processing, and the largest accumulation was in durable `RECEIVED` work before enqueue.
- A backup or one long-running transaction: the bounded activity audit found neither in this
  incident window.
- Redis OOM or eviction: Redis reported no evictions or rejected connections and remained below its
  memory capacity.
- Data loss as recovery: the backlog drained through the normal durable path; no queue, row, intent,
  or Redis state was manually cleared.

## Corrective Actions

- Runtime decisions now use an operational queue snapshot limited to two indexed oldest-row reads
  plus fixed default-webhook and action BullMQ counters. The full count/JSON/per-bot snapshot remains
  available only to the closed dashboard.
- Membership-cache invalidation is immediate in the local process. Remote publications are bounded,
  coalesced by transition, retained briefly across durable retries, and return a retryable deferred
  error on saturation, timeout, or failure. Oversized transitions progress through the same bounded
  admission instead of becoming poison items.
- Detached completion, timeout, failure, rejection, and peak in-flight metrics feed the webhook SLO.
- System mode exposes a rolling-deploy-compatible structured condition: `healthy`, `queue_backlog`,
  `max_api`, `mixed`, `stabilizing`, `manual`, or `unknown`.
- Publisher now uses the same host load and I/O-wait governor thresholds as other background owners.
- `monitor-readonly` samples CPU I/O wait, memory, swap, disk, readiness, and the webhook queue fence
  every 15 seconds by default. It stores only allowlisted scalars in private hourly JSONL files with
  14-day retention; full logs remain ephemeral unless an operator explicitly requests retention.
- The webhook load harness has baseline-derived 2x steady and 4x burst profiles, a 95% throughput
  floor, hard phase deadlines, and a separate protected operational drain check.

## Validation Boundary

- Production 2x/4x traffic is not an acceptance environment. Execute those profiles only on a
  dedicated staging or canary target after reviewing the dry-run plan.
- The corrective release requires contracts, API, mini app, Compose/infra, and full repository
  validation, followed by exact-SHA CI, guarded deployment of all affected components, and a
  five-minute read-only production observation.
- Success means readiness remains green, operational lag returns to the low-single-second range,
  the queue fence remains unpaused and unowned, no fresh cache saturation/failure signal appears,
  and every API role remains on the exact release image without restarts.

This document intentionally excludes tokens, request payloads, chat/user/bot identifiers, URLs, and
free-form production log content.
