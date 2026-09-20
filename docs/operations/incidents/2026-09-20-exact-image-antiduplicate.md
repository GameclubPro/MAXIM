# Exact Image Antiduplicate - 2026-09-20

## Requested Behavior

Retire the overlapping photo-filter modes, keep exact images and let chat administrators choose
same-author or chat-wide matching. The latest product clarification requires the same configured
explanation/WARN/MUTE/BAN ladder as text, not image-only deletion. No threshold reset is authorized.
The mini app must be clear, and default notices must not say that there are no additional sanctions.

## Implementation

1. Completed: one IMAGE path in the existing bounded message-duplicate queue, explicit new job
   identity, caption-independent complete image sets and the shared reaction executor.
2. Completed: atomic shared/author history for chat-wide matching, persisted replay decisions,
   bounded first-time lookup and final read-only revalidation. Other authors do not advance a
   participant's sanction ladder. Caption-only mode, immunity, permission checks and manual release remain.
3. Completed: disable the retired photo policy and producer; retain a drain-only old worker and
   reject old photo bindings. Production fingerprinting skips perceptual initialization/computation.
4. Completed: remove obsolete mini-app photo toggles/presets, keep one comparison mode and the
   author-scope choice, show common actions, and simplify standard duplicate notices. Stored
   administrator-authored templates are not rewritten by matching an old default string.
5. Completed: full impact validation, mobile visual checks, exact-SHA CI, scoped deployment and
   post-release observation. No schema migration is needed; deprecated fields remain inert.

## Reported Four-Picture Post

The user supplied a chat invitation and a screenshot of one post containing four photographs
and text, reporting that the post appeared twice in the configured interval. The second post,
message identifiers and an unambiguous date were not supplied. The public invitation returned
403 in a fresh unauthenticated browser, and the bounded Bot API lookup did not resolve it.
No existing participant message, sanction or chat setting was changed for diagnosis.

The regression fixture verifies the structure with four distinct images and text, a second
lossless-encoded/reordered publication, and one logical action. Replacing one image preserves the
new album. An explicitly allowed first repeat preserves publication two and removes publication
three. These tests establish supported behavior, not the cause of the specific live report.
Case attribution still needs both message references/time and the actual saved chat settings;
do not substitute an unbounded primary-database search or claim that the complaint is resolved.

## Validation And Delivery

Focused API run: 22 suites / 606 tests passed with disposable local Redis. Full API typecheck,
build and 588 suites / 12,988 tests passed; 14 environment-dependent suites / 71 tests were
skipped locally. Mini app type/CSS checks, production build and 1,354 tests passed. Contracts
passed 35 suites / 287 tests; repository static checks and 534 tooling tests passed. Safety Desk
passed 15 tests, build budgets and desktop/narrow browser smokes.

Strict native screenshots passed layout, contrast and accessibility checks for photo scope and
the reaction ladder on Android, iPhone and iPhone SE in light and dark themes. The staged wrapper
also checked threshold persistence. A separate 1280x900 browser check confirmed the selected
chat-wide option with no horizontal control overflow. Screenshots are transient, not source files.

Runtime commit: `f6f0837b30c3f865ec09714165348691fea9129e`. Its exact-SHA Required and CodeQL checks
passed, including PostgreSQL races and the mandatory real-Redis lane (16 suites / 183 tests). The changed shared speech
catalog selects all three release components, not only the API and mini app.

Before rollout, the complete 14:53:50Z-14:58:50Z observation window had 20 samples, no readiness or
queue-fence failures, and queue age 0-0.856 seconds (p95 0.724). It remained in automatic MAX-action
degradation/recovery and had one fleet-topology warning; it is not described as uniformly healthy.
The cumulative fleet restart count stayed at 19 without increases. Action, default moderation,
message-media background and enqueue roles had zero restarts when checked individually.

## Release

Deployed as `release-20260920T151718Z-f6f0837b30c3`. All three exact green CI images were loaded
through checksum, protected-identity and archive-plus-reserve checks, then reused by the normal
deploy. No disk guard was weakened and no host-wide cleanup ran. All 13 API roles, the OCR sandbox,
Major mini app and Safety Desk were updated. PostgreSQL/Redis were not recreated and no migration
was pending. The standard queue fence protected the mixed-version interval. Readiness temporarily
returned 503 during backlog recovery, then all API, static and isolated OCR smokes passed before
the manifest was committed.

Message authority remains permanent full revision 2. The retired photo policy returns OFF even
for an old advanced selection; its queue had no waiting, active or delayed jobs at the bounded
post-release read. Existing failed jobs were not reset. A separate capped ten-minute sample found
four failed non-IMAGE message jobs and no IMAGE failures; this is not a fleet success rate or
evidence about the reported post.

The completed 15:22:26Z-15:27:26Z window had 20 samples with complete coverage, no readiness,
queue-metric/fence or fleet-topology failures, and zero restarts. Sampled oldest-queue age was
0-1.334 seconds (p95 1.017), not request latency. Fifteen samples were in automatic stabilization,
so the entire window is not labelled normal. The final sample was normal/healthy with zero lag;
the separate 15:37:59Z check confirmed normal/healthy mode, healthy PostgreSQL/Redis and subsecond
queue lag. No existing participant content, settings or old sanctions were mutated for a live test.

Disposable local Redis, downloaded test binaries and local screenshots were removed after checks.
Read-only monitors removed their transient full logs and retained only the normal privacy-safe
capacity archive. Pre-existing user notes were preserved and excluded from both commits.

See [Exact Images](../runbooks/exact-photo-duplicate-repair.md) for current semantics and limits.
