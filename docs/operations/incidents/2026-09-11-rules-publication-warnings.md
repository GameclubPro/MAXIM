# Rules Publication and Warning Complaints - 2026-09-11

## Evidence Boundary

The report contains two private MAX join links and a screenshot saying that the previous rules
post is still being deleted. The exact screenshot message comes from pending rules cleanup,
before another publication is permitted. It is not a draft-save or image-validation error.

The links could not be authoritatively bound to managed chat IDs during this investigation:
public pages returned HTTP 403, and targeted Bot API reads did not resolve the invitations.
Bounded Redis discovery snapshots did not produce an exact match; those samples were incomplete.
No chat settings, participant state, existing messages, or database rows were manually changed.
The code defects below are verified independently, not asserted as proven causes in both chats.

Bounded production logs also contained a message-limit warning rejected before dispatch because
no eligible bot route existed. Its association with the reported group is unconfirmed. That
failure is distinct from optional-notice suppression and cannot be repaired by bypassing access
checks. Initial health reads showed working Postgres/Redis and a transient webhook backlog.

## Confirmed Defects

1. Rules reconciliation used `chat_rules.updated_at` as a cleanup lock. Attaching a durable intent
   updates that timestamp without editing the draft, and successful intent execution can clear
   the cleanup itself before the caller's compare-and-set. The caller rejected both legitimate
   progress paths instead of continuing from the confirmed state.
2. `AdminSettingsService` discarded the persisted cleanup kind and derived it from the current
   endpoint. Publishing after a pending reset used the republish reason; resetting after a pending
   republish used the reset reason. The private-control path already used the correct shared helper.
3. `WAITING_CAPABILITY` became ordinary `accepted`, so an unavailable original bot was presented as
   active deletion with an indefinite instruction to wait.
4. Explicit user-facing WARN notices still passed through the optional per-chat notice bucket.
   Once exhausted, the helper returned false without handing the warning to MAX action dispatch.
   The caller could nevertheless persist a WARN decision.

## Implemented Plan

1. Match cleanup by its exact message, original bot, cleanup kind, and publication identity while
   requiring no active publication fence. Do not use the generic row timestamp for cleanup ownership.
2. Re-read after confirmed cleanup. Accept both a local successful CAS and completion by the durable
   executor only when the expected publication state remains and no newer cleanup/send fence exists.
   Use the freshly read draft; the subsequent publish claim still checks its exact `updatedAt`.
3. Route both miniapp operations through `deleteChatRulesMessage`, preserving the existing kind and
   original bot. Keep bot-authored deletion origin-only; do not expand rollout cohorts or retry
   terminal/ambiguous sends automatically.
4. Distinguish capability waits in the administrator error. Keep their persisted publication-audit
   outcome as `accepted`, with a separate diagnostic reason, for existing recovery/rollback readers.
5. Exempt explicit user-facing notices from optional-notice suppression. Preserve queued interactive
   delivery, MAX per-token rate limits, routing checks, formatting, and auto-delete settings.
6. Cover durable completion races, metadata-only timestamp changes, concurrent saves, newer
   publication/cleanup fences, both endpoint directions, blocked capability, legacy audit shape,
   and warning delivery with an exhausted bucket. Retain optional-notice suppression tests.

## Validation and Rollout

- Focused rules/settings/cleanup/lifecycle suites, then `npm run check:api` and staged static checks.
- No schema, contract, frontend, or environment changes; no migration or static rebuild required.
- Commit only owned changes. Require green exact-SHA GitHub `Required` and CodeQL analysis checks.
- Deploy the shared API component through the standard wrapper, recreating all 13 API roles and
  reconciling the OCR sandbox while keeping Postgres/Redis intact. Use the normal queue fence,
  disk preflight, immutable release manifest, and strict health checks.
- Do not enable replacement-cleanup or cross-bot cohorts as an incident workaround.

## Remaining Group Verification

Obtain each exact managed chat ID and a recent failed-action timestamp from the operator. Confirm
the chat type and original rules bot, then inspect the exact pending intent and that bot's current
membership/capability through approved diagnostics. Request restored bot permissions when absent;
do not erase the fence or delete another message to make publication appear successful.

For the warning complaint, correlate a concrete violation with its enabled policy, escalation
count, author immunity, action route, and dispatch result. Warning-enabled does not necessarily mean
a WARN on the first violation. An absent executable bot needs access/routing recovery, not notice
limiter changes. No historical warning replay or participant sanction is part of this release.

After healthy rollout, the administrator should retry the saved rules once and verify that the
current post remains correct. Validate warning delivery with an approved test participant/content
in the default test chat, never by sanctioning real participants. Until those checks are complete,
the exact two group incidents remain unverified even if all code and deployment checks pass.
