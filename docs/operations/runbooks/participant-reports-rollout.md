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

The action role processes due cases in bounded batches. History scans use 25-row keyset pages
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

Both rollback paths require `ReportDeleteGuardService.BINDING_VERSION = 3`, current-case checks,
counter guards and the final delete boundary. An older executor is not a valid rollback, even when new report admission is
disabled: durable intents can survive the process that created them.

## Journal, Bulk Policy And Scheduling

The lightweight `GET /chats/:chatId/reports/availability` response is refreshed when the module
opens, on focus, and every 30 seconds while open. An existing saved opt-in may be toggled off
and back on in the same unsaved draft while admission is paused; a new opt-in remains blocked.

The journal uses server filters (`ALL`, `ACTIVE`, `FAILED`, `COMPLETED`, inclusive ISO date range,
and exact author), filter-bound cursors, and repeatable-read receipt-aware snapshots. Each
indexed status branch reads at most 21 ordered candidate IDs; a displayed page contains at
most 20 cases. The client polls only the first page and the selected active detail, never every
loaded historical page. Terminal details refresh on explicit action or focus. The manual refresh
updates both the first page and the open detail. Delayed responses cannot restore an obsolete
status or dismissal action.

Reports bulk apply requires the revision returned by the source section save and the exact
confirmed target set (at most 500 chats). Every target's merged command aliases are validated
before the first write and again inside its own revision-checked transaction. A source revision
or target-set change stops the operation before writes. A late failure returns bounded per-chat
outcomes and full applied/unchanged/failed/not-attempted counts; samples never authorize an
automatic replay. The UI preserves a confirmed source save, the final source revision returned
by its own bulk transaction, and later unsaved local edits. Navigation to another chat cannot
apply the old source draft to the new chat.

Persisted report deletes have an independent execution classifier. Disabled admission still
allows a persisted job to reach its final guard and settle a definitive rejection. Report
reasons cannot masquerade as an independent generic-delete authority. Every report authority
is evaluated deterministically; an independently valid case can authorize shared work even
when another case was revoked. Exact public-counter ownership is checked through generic
bot-message cleanup as well.

The report dispatcher reserves slots for decisions, running work and maintenance, with two
workers and an eight-second admission/render budget. This budget stops new work; it is not a
hard cancellation of an already running remote request. Historical deletes use background
priority (10), including recovery after reload; direct targets retain interactive priority (1).
History uses 25-event keyset pages and durable reservations under a brief PostgreSQL advisory
lock: active `RUNNING` cases reserve at most 1,000 pending history actions globally, 200 per chat
and 400 per origin bot. Revoked queued jobs can remain briefly until their final guards settle;
they do not retain history admission capacity. Queue/MAX calls happen outside that lock.
Final-page reservations recover even after the scan was marked
complete. Render fingerprints and durable event wakeups keep unchanged collections asleep
until their expiry; ambiguous sends never create a replacement counter.

`ReportTelemetryService` emits process-local aggregate counters and fixed duration buckets,
without chat, participant, message or case identifiers or message content. These observations
are baseline measurements, not a claim that production SLOs or live MAX scenarios passed.

## Detailed Data Retention: 30 Days

The selected policy is **30 days**. `PARTICIPANT_REPORTS_DETAIL_RETENTION_DAYS=30` is the default;
`PARTICIPANT_REPORTS_DETAIL_RETENTION_ENABLED=false` keeps removal disabled during rollout.
Activate it only after the additive archive/receipt migrations and every compatible API role
have been deployed and checked. Report admission may remain `off` independently.

Both API rollback paths unconditionally require `ReportViewService.ARCHIVE_READER_VERSION = 1`
and its retained-total/archived-reporter handling, plus the submission tombstone rejection before
policy-revision reopening. Turning retention off does not relax this floor: removed details stay
removed, and older readers would show zero totals or reopen a closed archive.

Removal considers at most five indexed expired cases per pass, rechecking each under the
existing chat fence and a case row lock. A case must be terminal, have no live lease or linked
intent, have exhausted its decision/ambiguous-send windows, and have both an old collection
expiry and an old last-change timestamp. Thus details are retained for at least 30 days after
recent closing or counter activity. A global Redis admission slot caps deletion at 200 vote/
action detail rows per minute across action replicas; the service fails closed without that
slot. Statement/transaction limits bound each pass.

Final counts are frozen before bounded deletion. Case identity, author/message/counter binding,
policy/content versions, terminal outcome and aggregate totals remain as a tombstone for dedupe,
counter recovery and late guards. Reporter vote identities and per-message action details are
removed. This policy does not erase independent moderation sanction records, required security
audit records or unrelated chat history. The public journal distinguishes an archived detail
from a missing case and continues to show confirmed deletion, independently confirmed absence
and failures separately.

For an isolated local database, `npm run reports:retention-preview --workspace @maxim/api --
--days 30` prints aggregate-only dry-run output. It requires a loopback `race_test` database,
uses one connection and a two-second statement timeout, and starts no workers. The sample
covers only the first five indexed candidates and at most 200 detail rows; a zero result can
mean that those five are blocked, not that the whole backlog is empty. The diagnostic never
selects production or an arbitrary remote database. Production diagnostics remain limited to
reviewed fixed operations; do not pass ad hoc SQL or this local script through the VPS wrapper.

## Human Acceptance Before Admission

Keep the environment ceiling `off` when human acceptance will be performed later. The release
can be validated with disposable PostgreSQL, mocked MAX delivery and browser/WebView emulation;
those results do not establish live human membership, MAX permissions or actual chat delivery.

When a reviewed test chat is made available, use at least two agreed human voters with confirmed
membership of 24 hours and a separate ordinary author of administrator-approved harmless source
messages. Self-reports are rejected, so threshold two requires both voters besides the author. Start with threshold
2, deletion of one message and restriction disabled. Verify one counter across bots, one vote per
human, duplicate-vote rejection, threshold deletion and matching journal receipts. Then separately
check the 24-hour observed history, optional software restriction and manual release, policy
cancellation, expiry, restart recovery, counter disappearance and paused admission. Changing the
global ceiling or adding a canary chat is an explicit operational step through the normal guarded
rollout, never a side effect of opening the settings screen.
