# Participant Reports

The module is chat-only and disabled in every chat by default. Public report commands are
`/report`, `жалоба`, and the configured exact aliases, only as direct replies. Votes require
MAX-confirmed human membership for 24 hours. Shared-chat bots use one PostgreSQL case.

## Release And Activation

1. Validate contracts, API, Prisma, miniapp, admin, infra, and PostgreSQL report race tests.
2. Deploy the additive migrations and all shared API roles using the normal exact-SHA wrapper.
3. Keep `PARTICIPANT_REPORTS_MODE=off` until every API role has the report pre-dispatch guard.
4. For a reviewed test, set `PARTICIPANT_REPORTS_MODE=canary` and
   `PARTICIPANT_REPORTS_CANARY_CHAT_IDS` to the comma-separated resolved test chat IDs through
   the normal reviewed environment/deploy workflow. Use only approved test accounts/content.
5. Enable the chat module and verify one counter, unique votes, threshold, expiry, deletion,
   optional mute, settings cancellation, restart recovery, and the admin journal.
6. Promote the environment ceiling to `on` only after the canary is green. Chat opt-in remains
   required. The bot must have group message read and write/delete capability.

The settings screen exposes `reportsAvailable` separately from `settings.reportsEnabled`. A paused
ceiling must appear as paused even for an existing chat opt-in. New opt-ins are rejected while
unavailable, including bulk apply; turning the module off, editing an existing policy and reading
the journal remain possible. A missing availability field from an older API is unavailable, not on.

## Recovery And Stop

The action role processes due cases in bounded batches. History scans use 200-row keyset pages
over `webhook_events_report_history_idx`, a fixed decision-time day, and durable delete intents.
The intent retention transaction snapshots each linked report action's final status before
removing its queue ledger, so completed journal counts do not become pending again after retention.
All message operations share the existing target-wide MAX limiter. History materialization
does not execute synchronous deletes or bypass higher-priority moderation work.

Changing report settings advances the database-owned revision. Pending guards reject an older
revision. Disabling the chat module or setting the environment ceiling to `off` stops further
report actions; it does not restore messages or lift an already issued mute. Use existing manual
unmute when needed. A send without a message receipt is ambiguous and never automatically
creates a second counter. The journal remains the source of truth if a counter is unavailable.
An authenticated bot-message webhook may attach an ambiguous receipt only for the exact original
bot, chat, reply target and attempted text. The receiving bot need not be the author. Counter
delivery failures do not prevent already-authorized durable execution through another eligible
bot; the public counter remains owned by its original sender.

Recovery repairs actions without an intent before applying its pending-page gate. Discovery skips
live leases and releasing a lease preserves any newer vote/dismissal/receipt wakeup. After a policy
change only untouched collections may restart with a new content version; dismissals and cases
that already began execution stay closed. Counter cleanup rechecks terminal state and defers while
a reopened collection is active.

Journal pages aggregate their bounded case list in batch. `deleted` counts confirmed successful
deletes, while `absent` counts independently confirmed absence. Both remain terminal receipts after
intent retention, but absence must never be presented as deletion performed by the bot.

Reports do not issue bans, propagate sanctions to other chats, or feed global-spammer evidence.
Mute is the existing software mute: new messages are removed, not prevented at the client.
History cleanup covers only messages observed by the bot. Never present incomplete work as
complete. Execution authorization expires one day after the threshold decision.

Both rollback paths require `ReportDeleteGuardService.BINDING_VERSION = 2`, current-case checks,
counter guards and the final delete boundary. An older executor is not a valid rollback, even when new report admission is
disabled: durable intents can survive the process that created them.
