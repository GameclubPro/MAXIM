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
7. Pending: full API/static validation, exact-SHA CI and guarded shared-API deployment; then
   confirm production readiness and runtime controls without replaying historical violations.

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
Full validation and delivery results will be recorded after completion.
