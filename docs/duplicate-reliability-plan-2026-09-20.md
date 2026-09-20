# Duplicate Reliability Plan - 2026-09-20

## Scope And Evidence

Review whole-message admission, fingerprint selection, deferred media comparison, revisioned
history, final delete guards, settings semantics and runtime controls. Preserve existing author
immunity, action claims, sanction thresholds, independent media verification and event deadlines.
This extends the [September 19 audit](operations/incidents/2026-09-19-duplicate-miss-audit.md).

No affected chat, message pair or occurrence time accompanied the complaint. A reproduced defect
is a possible cause, not proof of the cause of an individual report. A specific investigation
needs the chat, both messages, their authors, time/timezone and saved comparison settings.

At approximately 11:20 UTC the bounded production checks found normal/healthy mode, healthy
PostgreSQL/Redis and queue lag below one second. The complete hourly moderation-event sample
contained 243 duplicate deletions, 17 warnings and one mute. The status-index sample included
19 retryable, 30 waiting-capability, four expired and four terminal duplicate intents. Several
status samples and the settings sample were saturated; these are not fleet success rates.
No participant content, settings, old jobs or sanctions were changed for diagnosis.

Whole-message runtime authority is permanent revision 2, `full`, `all_enabled_chats`. The separate
photo-filter control is missing. Saved photo options therefore do not activate independent
perceptual or cross-author enforcement; verified whole-message photos are a different path.
Changing that rollout is an explicit product operation, not part of this reliability repair.

## Implementation

1. Reproduce fingerprint starvation and independent media-candidate loss using real local Redis,
   BullMQ ordering and content hashes before editing runtime code.
2. Keep the 16-fingerprint budget, but reserve representation for every enabled fingerprint kind.
   Use deterministic value selection when truncation is necessary; exact matching stays present.
   Candidate lookup and verified history must use the same selection.
3. Verify all distinct bounded media predecessors before recording the current occurrence. Keep
   a shared 30-second verification deadline and a 20-uncached-media budget per attempt. Reuse
   message/revision-scoped proofs across deferrals; never freeze a partial current count. Cache
   terminal baseline rejection separately from equality proof so invalid bytes cannot consume
   the same budget forever. Do not act retroactively on predecessors.
4. Add bounded, identifier-free operational counters for admission, matching, media evidence,
   worker deferrals and final guard outcomes. Aggregate locally and emit at most one structured
   summary per 30 seconds per active process; no per-message network/DB write or new public API.
   These count attempts, including retries, not distinct messages or confirmed deletions.
5. Validate focused real-Redis regressions, full API checks, static/refactor/docs checks and
   exact-SHA CI/CodeQL. Deploy only the affected shared API component through the guarded wrapper.
6. Verify readiness, runtime-control preservation, strict release smokes and a completed bounded
   observation window. Do not replay old violations or reset action claims to manufacture results.

## Resource And Safety Requirements

- No database migration, new dependency, fleet scan, per-chat sleep or weakened MAX permission
  check. The existing worker concurrency of two and ten-minute deferral lifetime remain.
- Resource exhaustion defers unfinished work; it must not be recorded as a non-match.
- Fingerprint selection cannot erase hidden navigation/actions or numeric meaning. It changes
  bounded coverage only, not the matching predicates or administrator-selected modes.
- Media candidates are pointers to receipts, never proof. Equality still requires independently
  verified bytes/canonical pixels. Unsupported files and incomplete split albums remain excluded.
- Negative evidence caches are not positive proof and must be isolated by receipt and resource
  policy. They can suppress rework but cannot grant deletion authority.
- Logs contain fixed outcome names and counts only, never chat/user/message IDs, contents, URLs,
  hashes, tokens, stack traces or free-form errors. Logging failure cannot alter moderation.

## Remaining Product Work

1. Use the new attempt counters to measure late events, unsupported media, budget deferrals and
   guard rejections before changing ordering or concurrency. Persisted delete receipts remain
   the source of confirmed deletion outcomes; counters must not be presented as a success rate.
2. Separate photo-filter activation requires a reviewed cohort and rollback procedure. Do not
   infer global permission from saved per-chat toggles or whole-message `full` authority.
3. Split-album assembly, additional binary formats, source renewal beyond photos and broader
   approximate matching need dedicated evidence/false-positive tests and resource designs.
4. Evaluate a bounded per-author ordering design only after measuring chat-wide head-of-line
   blocking; keep shared action-claim and edit ordering guarantees.
5. A UI-facing explanation for messages that never reached a delete intent would require a
   bounded per-chat diagnostic contract and privacy/retention review. Process summaries do not
   substitute for that feature or identify a particular complainant's message.

## Validation And Delivery

Both regression cases failed against the previous implementation before runtime edits. The
focused local run passed 32 suites / 452 tests with disposable loopback-only Redis, including
content hashes, history, ordering, retries, guarded enforcement and media budgets. Repository
lint, refactor guards, documentation checks and all 534 tooling tests passed.

Full staged API verification, exact-SHA CI and guarded deployment are pending.
