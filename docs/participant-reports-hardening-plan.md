# Participant Reports Hardening

## Findings And Scope

The reported "temporarily unavailable" response is the global execution ceiling, not a rejected
command spelling. Chat settings can currently say enabled while `PARTICIPANT_REPORTS_MODE=off`.
The interface must distinguish stored opt-in from actual availability; deployment must not silently
enable sanctions across existing opted-in chats.

Confirmed implementation gaps:

- A history action persisted without its delete-intent receipt can block all subsequent recovery.
- Authorization rechecks settings after remote calls, but not the current case/version; cancellation
  or content changes during those calls can escape the final case check.
- An edit webhook can overwrite a newer observed revision; an in-flight submission can similarly
  restore an older snapshot. Restarting collection after a settings change is unnecessarily blocked.
- Mute results may be omitted from the terminal status because the executor retains its pre-mute row.
- An ambiguous counter send is never reconciled from its authenticated reply webhook.
- Already-absent messages are presented as deleted, and journal pages perform per-case aggregate reads.
- Long-lived leases can occupy discovery slots, and final scheduling can overwrite a new vote's wakeup.
- A cancelled collection's old counter cleanup can delete a reopened counter; mirrored webhooks
  must bind the actual sender, not the receiving bot. Execution also needs an eligible read route
  when the original bot becomes unavailable, without duplicating its public message.

## Implementation Sequence

1. Strengthen current-case/version checks at execution and deletion boundaries; fence stale workers.
2. Repair unlinked actions before resuming paginated history, preserve truthful partial outcomes and
   keep history below urgent deletion work.
3. Reconcile exact counter receipts, preserve new wakeups, and re-open only untouched cancelled
   collections. Never re-open an administrator dismissal or an already executed punishment.
4. Expose server-authoritative availability, distinguish paused opt-in in settings, and reject new
   activation while the ceiling is closed. Keep settings disable and journal access available.
5. Batch journal aggregates, expose already-absent outcomes separately, and deduplicate paginated UI
   rows. Exercise error, loading, paused and active states on mobile light/dark viewports.
6. Run focused unit/PostgreSQL race tests, full impact verification, exact-SHA CI/CodeQL and the
   ordinary shared-API/static deploy wrappers. No production database repair or arbitrary SQL.

## Acceptance

Tests must cover a crash between action and intent persistence, cancellation/version change during
MAX calls, a failed target delete after a committed mute, out-of-order edits, counter-send ambiguity,
settings-revision restart, exact reply binding, expired leases, accepted-vote wakeups, bounded journal
queries and retained receipts. Existing thresholds, membership age, 24-hour limits, immunity,
multi-bot dedupe and 1000+ history coverage remain required.

MAX documents `ChatMember.join_time` in milliseconds:
https://dev.max.ru/docs-api/objects/ChatMember
Do not convert it to seconds or infer membership age when the field is unavailable.

## Activation Boundary

The existing canary rollout remains mandatory. Use only the resolved approved test chat and agreed
human test accounts with MAX-confirmed membership age. A successful deployment, mocked MAX test,
or UI screenshot is not evidence that real human reporting works. Global promotion stays separate
until that canary is observed and reviewed; ordinary chats remain opt-in afterward.
