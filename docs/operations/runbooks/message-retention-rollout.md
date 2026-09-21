# Message Retention Rollout

## Boundaries

Message retention belongs to Major group chats only. The independent policy API is
`/v1/chats/:chatId/message-retention`; generic settings and bulk apply do not own it.
Policies default off, support 24 or 48 hours, and never backfill chat history.
Changing the interval affects pending candidates. Disabling changes the activation
identity; re-enabling starts a new intake baseline, not a historical catch-up.

Capture accepts authenticated `message_created` envelopes with an exact message ID,
chat ID, explicit human sender and MAX message timestamp. Normalized event timestamps
are not message-age authority. Messages older than seven days at receipt are excluded
to fence replays after completed-state retention. Known administrator messages are
excluded locally; execution rechecks author access, current pin and policy.
Unknown rights/pin responses defer deletion, never authorize it. MAX cannot atomically
combine an external pin/admin update with a conditional DELETE.

## Runtime

`MESSAGE_RETENTION_MODE` defaults to `off`. `shadow` records candidates without MAX
deletion; its candidates remain non-executable after promotion. `canary` requires an
exact comma-separated `MESSAGE_RETENTION_CANARY_CHAT_IDS` cohort; `*` is not an allowlist.
`on` makes the module available to explicitly enabled chat policies, not every chat.
Keep the mode/cohort aligned across ingress, admin and `api-message-retention`.

`api-message-retention` is a headless shared-image role with a two-connection pool,
0.5 CPU, 512 MiB memory, one worker and a separate `message-retention` queue. The
30-second scheduler admits at most 100 outstanding chat wakeups using fixed BullMQ
slot IDs, native per-chat deduplication and global concurrency one. Legacy chat-keyed
jobs drain before slot admission. PostgreSQL owns
candidates and schedules; queue loss is recoverable. Each visit processes at most
five deletions, reduced to two under governor slow pressure. Pause prevents new
attempts. Database housekeeping continues in bounded batches when dispatch is off
or MAX pressure pauses it. Scheduler/cleanup do not run immediately at startup.

Every retention MAX call uses `background` and source `message_retention`. The
distributed source budget is two requests/second across all tokens and processes,
plus one retention deletion/second per chat and existing shared transport limits.
Reads and retries consume the same budget. This is not 172,800 guaranteed deletions
per day: rights, pin, recovery and absence checks reduce useful throughput.

The 32 transactional quota shards hold at most 62,500 active candidates each;
per-chat capacity is 50,000. Intake pauses at 80% and resumes below 60% after a stable
ten-minute window. A full shard can conservatively pause before the fleet total is
full. Paused intake is visible, counts skipped arrivals and resumes with a new date;
already accepted candidates remain. Completing/replaying a task releases credit once.
Terminal compact candidates and retention-only intents are purged after seven days
in bounded keyset batches; unresolved receipts retain their candidate and never block
later pages. Cleanup locks owned, non-live intents before candidates, never ordinary
moderation intents. Ordinary moderation history is unchanged.

Opted-in admission uses three SQL statements: indexed eligibility, quota-before-policy
locking, then atomic candidate/quota/audit changes. Inactive, historical and already
recorded messages stop at the first statement. Never add MAX calls or remote awaits
to the receipt transaction. Cached author evidence is discarded before refresh and
both pin and author TTLs start at request dispatch, not response completion.

Retention never appends a reason to an independently owned moderation intent. A
normal moderation writer atomically removes the retention reason and takes ownership.
The critical sweeper excludes retention ownership, and the retention runtime refuses
ordinary intents, including ownership changes between lookup and claim. Unknown
remote outcomes retain durable evidence. Terminal errors without a safe automatic
recovery remain visible and require operator review, not repeated blind deletion.

## Release Gates

1. Keep the runtime off while deploying the additive migration and compatible shared
   image to every role. Deploy the Major mini app and validate the contracts consumers.
2. Run `npm run check`, `node --test scripts/message-retention-migration.test.mjs`, and
   `node apps/miniapp/test/message-retention.browser.mjs` with `MINIAPP_TEST_BASE_URL`
   pointing at an owned local mini app server.
   `npm run test:retention-storage --workspace @maxim/api` executes the production SQL
   on embedded PostgreSQL. With an explicit localhost `MAXIM_TEST_POSTGRES_URL`, the
   same suite uses a disposable schema and concurrent clients; CI runs that variant.
3. Before enabling capture, compare PostgreSQL/Redis load and webhook/moderation
   p95/p99 under matching traffic, including multi-bot mirrors and removal updates.
   Test 10,000/20,000 chats and two million pending records on a representative
   disposable database. The embedded PostgreSQL migration/index check is not a
   replacement for concurrent live-engine or capacity testing.
4. Block promotion on >5% p95/p99 degradation, new critical errors, quota violations,
   growing backlog below the measured admitted capacity, or worker resource overruns.
5. Progress through bounded shadow, the approved test chat, 100 opt-in chats, then
   1,000. Observe each executing stage for at least 72 hours and verify deletion of
   specifically created test content older than 48 hours. Never test on existing
   user messages. Expand only below 60% of measured sustainable cleanup throughput.

Observe the `message_retention` source metrics, auxiliary queue, policy counters,
oldest due time, capacity pauses and core moderation latency. Do not run broad
production aggregates over raw webhook events for this feature.

## Stop And Rollback

Set the runtime mode to `off` through the reviewed runtime-environment/deploy workflow
and recreate the affected roles. This stops new intake/execution, preserving accepted
work. Per-chat disable separately cancels that activation; already dispatched HTTP
requests cannot be undone. Never delete Redis/Postgres data to stop the module.

Both API rollback paths require the retention-aware guard and critical-sweeper
exclusion. A pre-feature image may execute persisted retention intents as critical
work and is not a valid rollback target, even when its environment has retention off.
