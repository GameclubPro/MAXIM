# Message Duplicate Reliability - 2026-09-14

## Evidence And Scope

The initial read-only production check found a permanent revision-2 `full` control scoped to
`all_enabled_chats`. Ingress/admin readiness, PostgreSQL and Redis were healthy. This was not a
global disabled switch or a demonstrated fleet-wide MAX outage.

The fixed `postgres-audit duplicate` report found successful duplicate deletes, retryable intents
and expired work. Its capped samples are lower bounds, not fleet totals or success rates. A bounded
failed-job Redis sample also contained MAX 404s and media-download failures. No message contents,
identifiers, settings or queue jobs were exported or changed. These operational samples alone do
not attribute every reported missed deletion to one cause.

Four defects were reproduced with failing regression tests:

1. History detection used the duplicate's event-time window, but final verification shifted the
   lower bound to the dispatch clock. With a 60-second window, an original 65 seconds ago and a
   repeat 10 seconds ago were detected as a valid 55-second pair, then incorrectly rejected.
2. A transient exception during delete authorization was marked as a confirmed refusal. Both
   duplicate action handlers returned successfully, acknowledging unfinished work and preventing
   the original job from retrying its configured reaction.
3. A valid uncached MAX member response without the author was treated as transport uncertainty.
   Retrying could not restore deletion authority for a departed participant.
4. A terminal message-duplicate rejection fell through an OCR-oriented independent-reason check.
   The message duplicate's own reason counted as independent work and immediately rescheduled
   the same rejected intent. This also affected changed history, settings and runtime authority.

## Optimized Plan

1. Done: distinguish effective runtime configuration from per-chat settings using bounded reads.
2. Done: reproduce the failures before editing runtime code, including actual Redis Lua execution
   and both duplicate action handlers, not just mocked detection.
3. Done: preserve the event-time comparison window at final history verification. Keep revision,
   membership, current-content and absolute dispatch-deadline checks. No new reads or retention
   expansion are needed; the existing extended history TTL already supports this window.
4. Done: propagate temporary authorization failures for retry without applying sanctions or
   sending notices. A verified refusal remains a successful stop, not a retry.
5. Done: classify a confirmed departed author as a typed rejection. Transport failures, malformed
   replies and mismatched identities remain retryable and cannot authorize deletion.
6. Done: settle rejected message-owned intents under the existing row lock without counting their
   own reason as independent authority. Mixed reasons cannot bypass the required message guard.
   Do not purge queues, reset action claims or replay old moderation manually.
7. In progress: run focused Redis/BullMQ/media/enforcement tests, all API checks and scoped static
   validation; build and deploy the exact green SHA to every shared API role and OCR auxiliary.
8. Pending: verify production health, unchanged runtime control and bounded duplicate outcomes.
   Record release and validation results here after delivery.

## Product Boundaries

- Comparison remains per author and chat. Administrator and participant immunity are preserved.
- An allowed-repeat setting of `1` intentionally leaves the first repeat; `0` deletes the second
  occurrence. Existing settings are not reset by this repair.
- Whole-message media equality still requires verified content. Unavailable downloads, unsupported
  attachments, split albums and content beyond resource limits cannot prove equality.
- The separate perceptual/photo-only policy is not promoted by these changes.
- The absolute delete deadline remains tied to the repeat timestamp and configured window;
  preserving its original comparison window does not authorize indefinitely delayed deletion.
- A confirmed departed author is left untouched, not treated as proven safe to sanction.

See [Message Duplicate Rollout](../runbooks/message-duplicate-rollout.md) for runtime controls,
compatible rollback and live-test boundaries.

## Validation Notes

- The initial focused run passed 278 tests across 14 suites with disposable local Redis.
- Typecheck, repository lint/refactor guards, documentation checks and 505 tooling tests passed.
- A broader-than-CI run with Redis enabled for every API test passed 11,996 tests but failed nine
  tests in the unchanged `commercial-ocr-admission.redis-integration.spec.ts`. Its fixture calls
  the store immediately after construction, while its Redis client disables the offline queue.
  This optional OCR fixture is not enabled by the standard API CI step; the required Redis CI step
  targets `message-duplicate`. This repair does not change OCR admission or its test fixtures.
- Standard API validation, exact-SHA CI and release smokes are pending below; the expanded Redis
  run must not be described as fully green.
