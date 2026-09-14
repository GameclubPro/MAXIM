# Bot Latency And Departed-Author Retries - 2026-09-14

## Status

The corrective API release `166b494cad4a50569858df93a25df2061ef06769` is deployed in
`release-20260914T094848Z-166b494cad4a`. Exact-SHA CI, CodeQL, and guarded production smokes passed.
The extended observation finished with normal/healthy system mode, healthy ingress/admin readiness,
and no recurrence of the departed-author retry loop in the bounded failure sample.

## Evidence

All observation times are UTC. Diagnostics used the read-only monitor, the fixed PostgreSQL audit
catalog, and a bounded Redis sample of recent failed-job metadata. No application rows or queue jobs
were cleared during diagnosis.

- At approximately 09:10, ingress and admin readiness returned 503 with webhook lag above 540
  seconds. The bounded receipt sample reached its 2,000-row cap while BullMQ moderation queues were
  nearly empty. All 13 API roles had the expected identity and image; the rollout fence was released.
- The large receipt backlog drained naturally, but a small set of pristine received events remained
  behind a `retry_pending` ordered predecessor. By approximately 09:30, the oldest receipt was 1,403
  seconds old. Automatic system mode remained degraded despite successful database/Redis probes.
- A later pre-release readiness sample reached 1,924.449 seconds. Before rollout, the backlog
  naturally recovered to 0.82 seconds while CI was finishing. That recovery preceded the fix and
  is not evidence of a deployed performance improvement.
- One recent failed moderation job had made 47 attempts in 731 seconds with the fixed error
  `Profanity deletion author access is unavailable`. Recent 404 failures in the same bounded sample
  had only one attempt and were not the recurring failure.
- MAX action-health samples were overwhelmingly successful, including 1,389 successes out of 1,390
  operations in one 60-second window. The evidence did not indicate a fleet-wide MAX outage.
- The initial host sample showed load around 11 on 8 CPUs and Redis around 15,000 operations/second.
  Database connections remained available, there were no Redis evictions or rejected connections,
  and scheduled backup/restore services were inactive.

## Cause

The profanity deletion guard treated a successful, uncached member lookup that omitted the author
as a transient error. `MaxClientService.getChatMemberAccess` returns `null` for that valid absence;
transport failures and malformed member responses throw instead. Retrying a departed author could
therefore never establish the required deletion authority. Each retry kept the chat's ordered head
unfinished and blocked later messages. The old received events also kept the fleet's backlog-driven
degraded mode active after the larger burst had drained.

Two additional outbox costs were found during investigation:

- Preparation-settled pristine receipts still triggered a lookup in every webhook queue, despite
  having no committed queue activation. A regression fixture reproduced 100 lookups per queue for
  100 such receipts.
- Each poll included retained timeout settlement checks against canonical claims and semantic
  owners, even though those historical recovery checks do not need the live receipt polling cadence.

These are verified unnecessary costs, not a measured attribution of the entire initial burst.

## Correction

- A confirmed absent author now produces a typed profanity guard rejection. Both legacy execution
  and durable intents stop without deleting, recording a violation, or escalating sanctions.
  Ordinary webhook completion then releases its ordered head.
- Network failures, malformed responses, and mismatched author identities remain retryable and
  never authorize deletion. Existing administrator and participant immunity checks remain intact.
- Pristine receipts settled during preparation skip the impossible BullMQ job scan. Receipts with
  prior queue state still reconcile jobs, and active jobs are not removed.
- Retained completed-timeout recovery runs at most once every five seconds. Due retries and new
  receipts remain eligible on every poll. The same admission applies to selected-chat expansion.
- Slow enqueue batches report identifier-free stage timings, at most once every 30 seconds, without
  adding database or Redis probes.

## Validation

- Outbox regression suite: 95 tests passed, including repair cadence, due retries, active jobs, and
  bounded diagnostics. PostgreSQL race coverage also passed in CI for the outbox change.
- Profanity-focused suites: 810 tests passed, including webhook completion without sanctions for
  a departed author and continued retries for unavailable or malformed MAX responses.
- Final local API validation: 532 suites and 11,934 tests passed; typecheck and build passed.
  The 17 environment-dependent suites remained skipped locally because their services were absent.
- Repository static validation: lint, refactor guards, and all 492 tooling tests passed.
- Exact-SHA CI passed all required jobs, including PostgreSQL races, Redis integration, builds,
  and CodeQL. The verified CI image was preloaded to avoid compiling on the production host.
- The guarded rollout recreated all 13 API roles and their OCR auxiliary. No migrations were
  pending; Postgres, Redis, and static services were not recreated. Ingress/admin live and ready,
  public live, OCR isolation, UDS raster, and shadow-mode smokes passed before manifest publication.
- The rollout backlog exceeded the 2,000-row audit cap, then drained to five received events with
  a nine-second oldest age and subsequently to low-single-second lag through ordinary processing.
- The first capacity observation, 09:55:57-10:00:42, had 20 samples: 16 were below two seconds,
  but a transient burst reached 23.986 seconds and produced one sampled readiness 503 before
  recovering automatically. All samples had the exact 13-role fleet, zero restarts, and a released
  queue fence. Do not describe this first window as uniformly healthy or latency-free.
- A bounded 80-job failed-job inspection found no fresh author-access retry loop. A subsequent
  five-minute failure sample contained only one 404 failure with one attempt.
- The extended capacity window, 10:02:57-10:07:42, had 20 samples with no ingress or admin readiness
  failures and queue lag between zero and 3.368 seconds. System mode returned automatically to
  `normal` / `healthy`; no manual governor override was used. All 13 API roles remained on the exact
  image without restarts, and the queue fence remained released. A final semantic readiness check
  reported 0.561 seconds of lag with both API endpoints ready.

This report intentionally excludes message contents, user/chat/bot identifiers, request data, and
credentials.
