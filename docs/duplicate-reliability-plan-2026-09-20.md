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

## Confirmed Defects

1. High: media comparison retained only the first candidate pointer. With CUSTOM link matching,
   two independent original pictures could remain unverified; a later message matching both
   links verified only the first picture and missed a byte-equivalent second picture. Its current
   occurrence count then became a replay snapshot without the missing original.
2. Medium: taking the first 16 fingerprints let many links consume every slot after exact text,
   silently excluding enabled phone or near matching. A repeated phone in otherwise changed
   text therefore failed to match in CUSTOM mode.
3. Diagnostic gap: messages rejected before intent creation had no bounded aggregate outcome
   reporting. Existing intent history alone could not distinguish absent candidates, unavailable
   evidence, pressure, stale history or final guard rejection.

## Implementation

1. Completed: reproduce fingerprint starvation and independent media-candidate loss using real local Redis,
   BullMQ ordering and content hashes before editing runtime code.
2. Completed: keep the 16-fingerprint budget, but reserve representation for every enabled fingerprint kind.
   Use deterministic value selection when truncation is necessary; exact matching stays present.
   Candidate lookup and verified history must use the same selection.
3. Completed: verify all distinct bounded media predecessors before recording the current occurrence. Keep
   a shared 30-second verification deadline and a 20-uncached-media budget per attempt. Reuse
   message/revision-scoped proofs across deferrals; never freeze a partial current count. Cache
   terminal baseline rejection separately from equality proof so invalid bytes cannot consume
   the same budget forever. Do not act retroactively on predecessors.
4. Completed: add bounded, identifier-free operational counters for admission, matching, media evidence,
   worker deferrals and final guard outcomes. Aggregate locally and emit at most one structured
   summary per 30 seconds per active process; no per-message network/DB write or new public API.
   These count attempts, including retries, not distinct messages or confirmed deletions.
5. Completed: validate focused real-Redis regressions, full API checks, static/refactor/docs checks and
   exact-SHA CI/CodeQL. Deploy only the affected shared API component through the guarded wrapper.
6. Completed: verify readiness, runtime-control preservation, strict release smokes and a completed bounded
   observation window. Do not replay old violations or reset action claims to manufacture results.

## Resource And Safety Requirements

- No database migration, new dependency, fleet scan, per-chat sleep or weakened MAX permission
  check. The existing worker concurrency of two and ten-minute deferral lifetime remain.
- Resource exhaustion defers unfinished work; it must not be recorded as a non-match.
- Fingerprint selection cannot erase hidden navigation/actions or numeric meaning. It changes
  bounded coverage only, not the matching predicates or administrator-selected modes.
- Messages exceeding the fingerprint budget still cannot retain every value. Type balancing
  fixes starvation, not arbitrary-length value coverage. Previously stored truncated membership
  sets are not rewritten: same-revision retries can fail closed as stale until new messages warm
  the selected values. Existing guarded intents retain their original read-only history checks.
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

Full staged verification passed typecheck, build, 588 API suites and 12,986 tests with local
Redis enabled. Fourteen environment-dependent suites / 71 tests were skipped locally; this
does not claim local PostgreSQL coverage. The staged wrapper repeated static/docs checks and
pushed runtime commit `7ac7f55eae21ac152490e0c628dfdf6c270b0cf9`.

Exact-SHA CI and CodeQL passed, including PostgreSQL races, the mandatory Redis lane (16 suites /
177 tests), all image builds and native OCR smokes. Disposable local Redis and
downloaded test binaries were removed; pre-existing user notes remain untouched and outside the commit.

## Delivery

Release: `release-20260920T115705Z-7ac7f55eae21`.

The shared API image was loaded through the exact-SHA CI preload wrapper because the VPS root
filesystem was 92% used. Checksum, protected image identity and archive-plus-reserve capacity
checks passed. Deploy reused the verified image without building, weakening a disk guard or
running host-wide Docker cleanup. The caller-only documented Git SSH port 443 setting was used.

The plan selected only `api-shared`. All 13 API roles and the isolated OCR sandbox were updated;
PostgreSQL, Redis and both static components were not recreated. No migration was pending. The
standard queue fence covered active/detached work and the mixed-version interval. Readiness
temporarily returned 503 while the accepted backlog drained, then local ingress/admin live/ready,
public live, OCR isolation/UDS/shadow and internal readiness smokes passed before manifest commit.

Message control remains permanent `full`, revision 2, `all_enabled_chats`; the independent photo
control remains missing. Neither control nor per-chat settings were changed. A bounded initial
log read found 33 valid identifier-free diagnostic summaries, including 35 history matches and
34 intent handoffs. Those attempt counts overlap stabilization/retries and are not confirmed
deletions or a success-rate measurement.

The pre-release 11:44:52Z-11:46:52Z window had eight samples with complete coverage, healthy
readiness/queue/fleet checks, oldest-queue lag 0-1.438 seconds and no restart-counter increases.
The fleet's cumulative 114 historical restarts were unchanged in that window; exact inspection
confirmed zero restarts for action, default moderation and message-media background roles.

The completed post-release 12:02:30Z-12:07:30Z window had 20 samples with complete coverage.
Readiness, queue metrics/fence and exact API fleet topology had no failing or unknown samples;
no restarts were observed. Oldest-queue lag was 0-1.19 seconds (p95 0.635). These are queue-age
samples, not request latencies. Seventeen samples were still in automatic stabilization, so the
entire window is not labelled normal. The final sample was `normal / healthy`, lag 0.178 seconds;
the separate 12:07:04Z health check also confirmed normal automatic mode and healthy DB/Redis.

Both read-only monitors finished normally and removed their transient full logs, retaining only
the ordinary privacy-safe capacity archive. No real participant was used for an agent-initiated
sanction test. Existing disk-headroom and swap warnings remain operational follow-ups, not
justification for changing detection limits or deployment safeguards. These observations verify
release stability and working diagnostics, not that every reported duplicate miss is resolved.
