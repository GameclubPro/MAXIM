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

## Recovery And Stop

The action role processes due cases in bounded batches. History scans use 200-row keyset pages
over `webhook_events_report_history_idx`, a fixed decision-time day, and durable delete intents.
All message operations share the existing target-wide MAX limiter. History materialization
does not execute synchronous deletes or bypass higher-priority moderation work.

Changing report settings advances the database-owned revision. Pending guards reject an older
revision. Disabling the chat module or setting the environment ceiling to `off` stops further
report actions; it does not restore messages or lift an already issued mute. Use existing manual
unmute when needed. A send without a message receipt is ambiguous and never automatically
creates a second counter. The journal remains the source of truth if a counter is unavailable.

Reports do not issue bans, propagate sanctions to other chats, or feed global-spammer evidence.
Mute is the existing software mute: new messages are removed, not prevented at the client.
History cleanup covers only messages observed by the bot. Never present incomplete work as
complete. Execution authorization expires one day after the threshold decision.

Both rollback paths reject images/ref targets without `ReportDeleteGuardService` at the final
delete boundary. An older executor is not a valid rollback, even when new report admission is
disabled: durable intents can survive the process that created them.
