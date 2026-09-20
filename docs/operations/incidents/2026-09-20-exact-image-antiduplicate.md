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
5. In progress: full impact validation, mobile visual checks, exact-SHA CI, scoped deployment and
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

Focused API run: 22 suites / 606 tests passed with disposable local Redis. Mini app type/CSS
checks and 1,354 tests passed. Contracts passed 35 suites / 287 tests; repository static checks
and 534 tooling tests passed. Full API and strict mobile checks are being completed.

See [Exact Images](../runbooks/exact-photo-duplicate-repair.md) for current semantics and limits.
