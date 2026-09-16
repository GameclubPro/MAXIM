# Duplicate And Interval Audit - 2026-09-16

## Scope And Evidence

Reviewed whole-message/text duplicate history, photo history and final authorization,
photo/sticker cooldowns, burst anti-spam and message-count limits. Publishing recurrence,
MAX transport rate limits and night-mode schedules are separate policies and are not changed.

A bounded production audit found healthy ingress/admin readiness, PostgreSQL and Redis,
automatic normal mode and queue lag below one second at the initial observation. Duplicate
deletions were present. The hourly delete-intent sample included 35 retryable and 24 expired
duplicate intents; other status samples hit their caps. These are bounded observations, not
a fleet success rate or proof that every production miss has the same cause. No participant
messages, sanctions, settings, runtime controls or historical jobs were mutated for diagnosis.

The whole-message control was permanent revision 2, `full`, scoped to `all_enabled_chats`.
The separate photo-filter control was missing, with no revision. A missing photo control cannot
authorize its standalone enforcement even when per-chat photo settings are saved. Verified
whole-message media comparison is a separate path. Neither rollout was promoted by this work.

## Confirmed Defects

1. Photo/sticker, burst and message-count counters discarded the decision on repeated webhook
   delivery. A failure after counting but before durable enforcement could therefore lose the
   violation on retry. Replaying an accepted original must also retain its original allowance.
2. Media cooldowns used processing time. Delayed or reordered deliveries could reject a valid
   interval or accuse an older original. The configured window also had an extra second.
3. Any settings `updatedAt` change reset both media cooldowns, including unrelated greeting edits.
4. Burst anti-spam used a fixed seven-second bucket for a six-second policy. The general quota
   also used a fixed bucket rather than the preceding configured event-time window.
5. Photo analysis received `windowSec + 1` as its comparison window. Perceptual lookup included
   the lower boundary while exact-photo/text lookup excluded it.
6. Photo admission/final authorization checked old events but did not reject materially future
   timestamps. Text admission accepted the exact expiry instant although its final guard did not.

The new Redis regression cases failed against the previous implementation before the fixes.
Existing whole-message event-time history, edit invalidation, author/chat isolation and final
history revalidation were retained, with additional exact-boundary coverage.

## Implementation Plan

1. Completed: reproduce failures with actual Redis Lua execution and focused service tests.
2. Completed: atomically store the accepted event-time media anchor and each message's decision.
   Rejects do not move the anchor; retries recover the same decision. Late older originals,
   expired events and materially future events do not acquire authority. Missing trusted event
   timestamps skip these stateful checks. The Redis deadline precedes writes; lost responses
   retry against stored decisions.
3. Completed: isolate cooldowns by chat, author, media kind and configured interval, not generic
   settings metadata. A changed interval selects separate history; disabling/re-enabling the
   same interval does not erase still-live history.
4. Completed: reuse revisioned event-time history for burst/quota counting. Count chronological
   predecessors in `(event - window, event]`, cap returned counts at the actionable threshold,
   preserve replay snapshots and use bounded 120/250 ms state budgets. Timeout propagates for
   retry rather than acknowledging unfinished production work.
5. Completed: use the exact photo comparison window and exclusive perceptual lower bound;
   align event expiry and future-skew guards. Bind the corrected window semantics into the photo
   authorization digest so old observation/action bindings cannot silently gain new authority.
6. Completed: add interval and photo-boundary Redis suites to the existing mandatory CI lane.
7. Completed: local API/static validation, exact-SHA CI and CodeQL, guarded shared-API deployment,
   production readiness and runtime-control verification without replaying historical violations.

## Operational Semantics

- The second photo/sticker is allowed at a timestamp difference exactly equal to its interval.
- A rejected photo/sticker does not restart the interval. Media blocked by an earlier rule-engine
  violation still does not spend this allowance.
- Burst remains a violation on the sixth eligible message within six seconds. Quota limits and
  configured sanction thresholds are unchanged. Quota counts attempted eligible messages,
  including quota violations, as before; it is not an accepted-message allowance.
- State is bot-independent and isolated per author/chat. Existing enforcement claims and durable
  intents, not detection counters, remain responsible for preventing duplicate side effects.
- No database migration, new MAX call, per-chat sleep or fleet scan is introduced.
- New media `v3` and burst/quota `v2` Redis namespaces intentionally do not reinterpret old
  processing-time counters. This causes a one-time cold start of these counters at rollout;
  old keys expire naturally. Whole-message duplicate history is not reset.
- Media uses one atomic Redis operation per enabled kind. Burst/quota reuse the existing bounded
  GET/CAS history path. Physical TTL includes retry/skew retention; logical enforcement does not
  use that extra TTL as additional comparison time.

## Remaining Improvements

1. Add identifier-free counters for admitted, blocked, stale, replayed and deadline-exceeded
   interval checks, plus final duplicate rejection reasons. Existing sampled audits cannot
   explain every missed delete or distinguish unavailable evidence from an actual non-match.
2. Evaluate shared admission/finalization for mixed attachments and asynchronous whole-message
   checks. A photo admitted by the synchronous rules may subsequently be removed by another
   async policy; restoring its allowance requires a revision-safe compensation protocol, not
   unconditional deletion of a Redis key.
3. Review photo sanction-counter semantics explicitly: photo clusters currently advance committed
   violation counts while a matching chain stays active, whereas whole-message decisions use
   rolling occurrence counts. Changing that policy needs series tests across window boundaries
   and a replay-compatible counter transition; this patch does not silently redefine the ladder.
4. Consider bounded reordering only after measuring late-event frequency. Current handling is
   conservative: it does not retroactively punish an earlier message using later evidence, but
   may miss an action when predecessors arrive after the later event was already processed.
5. Whole-message media equality still requires verified content. Unavailable downloads,
   unsupported attachments and incomplete split albums are not equality proof. These safety
   exclusions, administrator immunity and runtime rollout ceilings remain unchanged.

## Validation

Focused local run: 39 suites and 1,212 tests passed with disposable loopback-only Redis,
including text/media duplicate history, photo moderation, rule engine and enforcement.
Full local API validation passed typecheck, build, 542 suites and 12,380 tests. Twenty
environment-dependent suites (110 tests) were skipped in the standard run; focused Redis tests
ran separately. Repository lint, refactor guards, documentation checks and 505 tooling tests
passed. The full API run initially exposed outdated shared test doubles in two suites; those
were updated and both targeted (139 tests) and full validation then passed.

Runtime changes were committed as `8d5e964bd08497e84655a5a3de028cce95bfbb8e`.
Exact-SHA CI and CodeQL passed. The mandatory Redis lane passed 13 suites and 148 tests;
PostgreSQL races, all Docker builds, native OCR smokes and other required CI lanes also passed.

## Delivery

Deployed in `release-20260916T000024Z-8d5e964bd084`. The verified exact-SHA CI image was
preloaded because host disk utilization was above the normal build target. Checksum, image
identity and archive-plus-reserve capacity checks passed; no disk guard was weakened and no
host-wide Docker cleanup was run.

All 13 shared API roles and the OCR sandbox were updated. PostgreSQL, Redis and both active
static components were not recreated; there were no pending migrations. The standard queue
fence covered the mixed-version interval. Readiness briefly returned 503 while the paused
backlog drained, then ingress/admin live/ready, public live and sandbox isolation/UDS/shadow
smokes passed before the release manifest was committed.

The whole-message runtime control remained permanent `full`, revision 2, `all_enabled_chats`.
The separate photo control remained missing. Settings and historical sanctions were not reset.
An early post-release bounded hourly audit included 24 duplicate-delete events; its intent
sample contained 15 successful, 23 retryable, 12 waiting-capability, 11 expired and one terminal
duplicate intent. Several status samples saturated their caps and the window overlaps the
previous image, so these numbers do not establish an improvement rate or eliminate all misses.

The completed `00:04:34Z` to `00:09:34Z` observation window had 20 capacity samples with complete
coverage: no readiness/queue-fence failures, exact 13-role identity/image, no unexpected roles
and no restarts. Sampled oldest-queue lag was 0 to 1.249 seconds (p95 0.458); this is not request
latency. Eighteen samples still carried the automatic stabilization warning, so the whole window
is not labelled normal. Its last sample was `normal / healthy`. The final `00:10:39Z` health
check confirmed normal automatic mode, successful ingress/admin readiness and zero queue lag.
Disk-headroom and swap-usage capacity warnings remain operational follow-ups, not reasons to
weaken deploy safeguards. No real participant was used for an agent-initiated live sanction test.

Disposable local Redis was stopped and removed. The read-only monitor keeps only its ordinary
privacy-safe capacity archive; its transient full log is removed by the monitor lifecycle.
