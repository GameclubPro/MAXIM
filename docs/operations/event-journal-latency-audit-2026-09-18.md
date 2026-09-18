# Event Journal Latency Audit - 2026-09-18

## Scope And Evidence

This is a bounded audit of event delivery, production diagnostics, and the chat event journal,
not proof that every event workflow is correct. No user messages, sanctions, permissions,
application rows, failed jobs, or rollout fences were changed during diagnosis.

Observations at approximately 14:58-15:02 UTC:

- Ingress/admin readiness and database/Redis checks passed. All 13 API roles were running with
  the expected identity and exact image; the rollout fence was released. Three accumulated
  API restarts remained unchanged in the samples; their cause was not established.
- Sampled oldest pending event age ranged from zero to 1.838 seconds in the capacity samples.
  These are queue-age observations, not end-to-end latency percentiles or a busy-hour SLO.
- The bounded database report found 42 failed receipts in its 30-minute window and at least
  2,000 processed receipts (the cap was reached). A separate historical queue report found
  1,910 retained FAILED receipts, with an old timeout quarantine at the head. Retained failures
  are not equivalent to a current queue backlog and were not cleared.
- A read-only sample of five failed jobs from each of 16 default shards contained 79 remote
  not-found errors and one other error. Only 42 of the not-found jobs were from the preceding
  30 minutes. All sampled jobs had one attempt; sampled not-found duration was at most one
  second. This sample does not reproduce the previously fixed author-access retry loop.
- Bounded role logs included MAX 404/not.found responses, missing moderation permissions,
  internal limiter admission refusals, access-loss handling, and failed dialog notifications.
  Action logs also contained unavailable poll publications and Publisher actor-access blockers.
  An arbitrary 404 must not be converted into confirmed successful deletion or retried sends.
- Slow-path samples included one 9,932 ms webhook under a 10,000 ms watchdog, one 8,651 ms
  enqueue batch (8,229 ms enqueue stage), and 3,183 ms in commercial detection. These are
  individual observations, not attribution of all user complaints. The webhook profile's
  `latestStage=start` and empty stage durations leave a diagnostic coverage gap.
- One PostgreSQL sample showed an eight-second action-role delete-intent query waiting on
  DataFileRead. Most connections were idle. No raw SQL or unbounded database scans were used.
- Available Docker space was approximately 40 GiB, near the monitor's warning boundary.
  Swap usage was approximately 15%; the short sample does not establish sustained pressure.

## Confirmed Journal Defects

1. The dashboard had neither periodic refresh nor focus refresh. `staleTime=30_000` marks data
   stale but does not schedule a request. An open journal could remain unchanged indefinitely.
2. Both event hooks treated a cached first page as the result of an explicit retry. Pressing
   Retry could perform no request. Dashboard updates could also overwrite paginated history.
3. Feed request identity omitted the chat/channel ID. Switching entities at the same range
   and filter could retain old rows or accept a response for the previous entity.
4. React state alone guarded pagination: two same-tick clicks could enqueue overlapping reads.
   Pages were appended without ID deduplication or repeated-cursor validation.
5. Failed continuation retry loaded the first page, losing history instead of retrying its cursor.
6. Head pages used the same 30-second server TTL as history. Async stored dashboard snapshots
   were marked freshly fetched on hydration. Moderation feed startup also waited for the dashboard.
7. Summary-based empty states could contradict a fresher event list.

## Implemented Plan

| Priority | Change                                                                                      | Acceptance                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P1       | Share the two event hooks' request lifecycle; include entity, range, filter, limit in scope | Old rows hidden synchronously; stale responses discarded; unmount aborts any active request                      |
| P1       | Revalidate snapshots and make explicit refresh a real head request                          | Late dashboard data cannot replace authoritative feed results                                                    |
| P1       | Poll active chat heads every ten seconds after completion                                   | One request in flight; hidden/offline windows do no polling; visibility/network return refreshes                 |
| P1       | Back off failures to 20/40/60 seconds; stop automatic refresh on terminal client errors     | Existing rows remain available; explicit retry remains possible                                                  |
| P1       | Lock, deduplicate, and validate pagination                                                  | Duplicate clicks coalesce; repeated cursors fail; continuation retry preserves history                           |
| P2       | Cache only head pages for five seconds; history stays at 30 seconds                         | Authorization still runs before every cache hit; concurrent identical reads share work; rejected work is evicted |
| P2       | Refresh summaries every 30 seconds, preserve stale snapshot timestamps                      | No polling of participant/sanctions views; no secondary-tab prefetch on every summary update                     |
| P2       | Add an accessible refresh icon and consistent empty/error states                            | Narrow iPhone/Android and desktop layouts; light/dark; no overlapping header controls                            |

History deliberately freezes after loading a continuation, including after a continuation error.
The explicit journal refresh returns to the current head. This avoids silently removing older rows,
mixing incompatible cursors, or creating gaps while users inspect history. Channel activity reuses
the request-safety corrections, but this change does not introduce continuous channel polling.

The expected healthy active-head refresh budget is ten seconds plus request duration, with at most
five seconds of server-cache age. It is not a guarantee about upstream MAX delivery or processing.
This adds at most six head reads and two summary reads per minute per open active chat journal,
before pauses/backoff; closed views add none. Existing indexed read models and local-only profile
resolution remain in place. There is no new live MAX lookup, migration, queue, or dependency.

## Follow-Up Gates

- P1, per-entity access: an authorized chat administrator must restore intended bot rights or
  Publisher access through existing flows. Do not bypass authorization or borrow another bot profile.
- P1, not-found outcomes: correlate one exact reported action/time with its durable receipt and
  deletion-intent outcome. Keep ambiguous responses fenced; mass replay would risk duplicate actions.
- P2, slow processing: observe a representative busy period with the private capacity archive and
  existing hot-path diagnostics. Review the delete-intent query's plain EXPLAIN and exact indexes
  through a reviewed bounded audit-catalog extension before changing SQL or concurrency.
- P2, observability: extend stage coverage around unprofiled pre-moderation work and compare
  receipt-to-processed, action-completion, and journal-visibility distributions separately. Queue
  oldest-age percentiles must never be presented as request latency percentiles.
- P3, push updates: consider authenticated SSE invalidation only after measuring polling traffic.
  Use bounded per-entity subscriptions, replay cursors, heartbeat/reconnect backoff, and polling
  fallback. SSE cannot repair upstream delays; introducing it now adds a delivery/auth lifecycle
  without evidence that the bounded head reads are a bottleneck.
- P2, host capacity: review sustained I/O, swap-in, restart deltas, and manifest-aware image inventory.
  Do not raise pool sizes, add workers, or run host-wide Docker garbage collection from short samples.

## Validation And Delivery

Regression coverage includes real-browser request races for both feeds and server cache expiry,
concurrent-read coalescing, failure eviction, and access revocation. Run the focused browser suite
with `node apps/miniapp/test/events-feed.browser.mjs` against a local Vite server, plus mini app
checks/build, API checks, static guards, and the responsive journal smoke.

Required deployment selects `api-shared` and `miniapp-major-static`, after exact-SHA Required
and CodeQL success. All shared API roles and the OCR auxiliary must converge through the normal
queue-fenced rollout. Postgres, Redis, and Safety Desk are not deployment targets. A successful
release requires strict smokes and a bounded post-deploy observation, not merely passing tests.

## Delivery Outcome

Runtime commit `f1598fcb6c011bea622614ef4d9b6c1d34db8fba` passed exact-SHA Required and
CodeQL checks and was deployed in `release-20260918T155456Z-f1598fcb6c01` using verified CI images.
All 13 API roles, their OCR auxiliary, and the Major mini app were updated. Postgres, Redis,
and Safety Desk were not recreated; there were no pending migrations. Ingress/admin live and
ready, public live, canonical mini app, and isolated OCR smokes passed.

Local validation passed 12,820 API tests, 1,353 mini app tests, 510 tooling tests, typechecking,
API/production mini app builds, and responsive/browser regressions for both feeds. The 121
environment-gated API tests were skipped in the ordinary API lane; CI separately passed 156
Redis integration tests and the PostgreSQL race lane. The bundle check initially detected
unnecessary polling code on channel statistics; separating the journal-only scheduler restored
the existing budget check without raising limits. The generic visual smoke initially reused an
old dev server interrupted by contract rebuilding; the same smoke passed on a fresh local port.

The queue-fenced rollout temporarily reached 183.928 seconds of oldest pending-event age.
After resume it drained through ordinary processing. The first post-release capacity window,
15:59:07-16:02:07 UTC, had complete coverage (12 samples), zero readiness/fleet/fence failures,
zero restarts, and queue age from zero to 1.997 seconds (median 0.38 seconds). Automatic mode
remained `stabilizing` throughout this window; do not describe it as uniformly normal or use
these queue-age measurements as end-to-end journal latency percentiles.

Extended observation confirmed automatic return to `normal` / `healthy` at 16:04:12 UTC,
without a manual governor override. At 16:05:01 UTC readiness was healthy with 0.044 seconds
of oldest pending-event age. The same 60-second action snapshot still contained 28 failures
out of 1,501 actions, with zero critical failures: the journal correction does not resolve
every MAX action failure. The existing per-entity/not-found follow-up gates remain necessary.

Deployment also reported that production `.env` lacks `POSTGRES_PASSWORD` and Compose still
uses its legacy compatibility fallback. No secret was printed or changed. Before any separately
planned PostgreSQL recreation, an operator must synchronize this setting with the current
database credential through the existing secret-management process. It is not a reason to
recreate the database during an application release.
