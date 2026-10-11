# PostgreSQL admission and bot audit, 11 October 2026

## Evidence before correction

The API runtime was `b29d7f78990bb8f8f104849679eb5fc531a1f6c8`, image
`sha256:a3d5af2a1ea11da367c085a1133517ea772d248aaaab0827aef40bdf56912808`, release
`release-20261011T083353Z-b29d7f78990b`. The preceding 08:47:45–09:02:45 UTC healthy
window does not cover this later incident.

An ordered predecessor was received at 09:24:08.979 UTC, entered its business handler
at 09:24:10.238 and failed at 09:24:16.273 in `api-moderation-realtime-d`. The last
recorded stage was `violation-admin-recheck`; that stage covers several subsequent
operations, so the specific failing domain query is not established. The claim retained
business-start evidence without completion. Its later quarantine marker is not the
original cause. A fresh readiness observation failed at 09:29 with 291.7 seconds of lag.

A bounded Redis event-stream read for 09:24:00–09:25:00 UTC across the sixteen default
shards found two pg-pool waiting-list admission failures at 09:24:16.300 and 09:24:17.907.
The exact dependency error was `timeout exceeded when trying to connect`. Inspection
of the pinned pg-pool implementation places it before a client reaches the caller.
This proves admission failure, not an attempted SQL statement or MAX action. Later
database snapshots did not establish long-running stuck SQL. Moderation pools retain
their existing caps; raising concurrency without evidence is not the correction.

Separately, roster refresh produced 70 fresh failures in five minutes. A capped
twenty-minute sample of 128 failures contained only the typed
`ManagedEntityActivationRequiredError`. Passive retries cannot perform the required
administrator activation. The capped sample does not establish every historical cause.

## Correction and boundaries

- Retry pool acquisition once only for the exact expired waiting-list admission, before
  any client/SQL reaches the caller. Pool caps and each acquisition timeout remain fixed.
  Total admission may take two waits; production's five-second setting permits ten seconds.
  SQL, transaction callbacks, commits and external effects are never retried by this wrapper.
  Every Prisma lifecycle owns and disposes its pool, including reconnect.
- Avoid an empty immunity transaction when exact indexed grant and logical-message receipt
  probes both return absent. Existing receipts retain ownership/current-grant validation.
  Grant absence is not cached; quota consumption and concurrency locks remain unchanged.
- Treat a typed activation requirement as a dormant roster candidate, using the existing
  per-bot backoff. Healthy peers continue; fresh handshake/bot-added checks may recheck rights.
  Another candidate's propagating rights still retry. Unknown errors remain errors, and
  passive refresh cannot activate a bot or clear a shared roster on incomplete evidence.

Real PostgreSQL/Redis regressions cover occupied-pool recovery, bounded failure, callback
release, shutdown, reconnect, no replay after a SQL/transaction failure, immunity quota
races and two exact index probes with 20,000 retained grants and receipts. Native webhook
full-path guards retain the no-replay and independent-progress cases. Two fixture mistakes
and one error-text expectation were corrected without changing production guards.

## Broader audit before release

The 09:42:07–09:52:07 UTC bounded module log sample had no input truncation. Publisher
refreshes continued, including confirmed bot/roster proofs. The 09:52:29 access census
covered all 23,169 sampled binding rows in one bot scope; ten confirmed-admin snapshots
were expired. Snapshot freshness is not delivery success or historical deadline coverage.
Four sampled IN_PROGRESS occurrences had SENT delivery receipts; terminal publication
history was capped and includes ambiguous attempted sends. No publication was replayed.

Poll rendering reported 31 ambiguous exact-presence HTTP 404s in that ten-minute sample.
The existing repair loop spaces failed background attempts by five minutes; these errors
do not prove message absence and must not cause publication recreation or grant changes.
The duplicate diagnostic hit its server statement timeout after a plain plan was collected;
that report is incomplete and its bounds were not widened.

Release identity, recovery counts and post-release acceptance will be recorded after the
normal exact-SHA CI, fixed-scope recovery and shared-image deployment complete. Historical
started handlers are not recovered by the new acquisition wrapper itself.
