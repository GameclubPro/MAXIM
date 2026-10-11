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

All six active moderation bots passed exact identity and webhook-target reads at
09:56 UTC, with one subscription each and no missing required update types. Publisher
passed its independent identity probe and, at 10:48:51 UTC, its exact subscription
target and required update types. These were bounded read-only requests, with no
test messages or subscription mutations. The 10:08 bot-load snapshot recorded MAX
activity for all seven bots; it does not prove every feature performed an action.

The 54-namespace queue census distinguishes future schedules from overdue work and
terminal failure history. Night mode and VK retained future schedules with no due-now
jobs; OCR and duplicate queues were not cleared. A complete closed pre-release cohort
at 10:37:57–10:38:27 UTC contained 327 PROCESSED, 60 DUPLICATE and two FAILED receipts,
with no pending/cancelled rows. Processed-only p95 was 1.642 seconds. Those two failures
remain unclassified; this small healthy cohort does not resolve the old ordered head.

The Publisher comment failure sampled at 10:32–10:42 was a setup/readiness refusal
before dispatch. Later interactive action failures included HTTP 404 from the final
required-subscription target membership read. Neither observation authorizes sending
without current access, activating a module or replaying an uncertain action.

## Validation and release preparation

Runtime correction: `6deabb6905ce66f4b0a87fac147014d2dad6ea0c`. Release candidate:
`c72721574284f4ebd6222ba0f3575fd6c148701d`, whose additional change only batches the
retained-history test fixture into two `generate_series` inserts. The fixture still
contains 20,000 grants and 20,000 receipts and asserts the actual index plan.

Local staged checks passed 745 API suites and 19,067 tests; 98 store-dependent suites
and 2,123 tests were skipped in that mock-only run. A separate native PostgreSQL 16 /
Redis 7 run passed 172 focused tests across six suites without skips. The fixture
correction separately passed all six native immunity tests.

Exact-candidate CI's PostgreSQL lane passed all 1,420 tests: 1,286 native race checks,
three traffic-policy checks, 61 participant-report checks, 50 retention-storage checks
and 20 moderation-rollup checks. The first candidate's history fixture exceeded its
five-second test timeout; the correction changes fixture preparation and its test
deadline, not runtime limits. Candidate c727's first Static attempt failed when a
child Node process aborted inside an unchanged rollback-guard test. Its focused local
rerun passed. The hosted Static rerun and Required aggregate then passed without
source changes. Exact-candidate Required (run `38132419378`) and CodeQL
(run `38132419402`) were both verified before preload; failed evidence is retained.

Manifest-aware cleanup used the fixed cutoff `2026-10-11T09:00:00Z` and removed five
unused MAXIM image references outside protected release history. Six manifests and
13 image identities remained protected. One apply refused a disappearing Docker
object before deletion; a complete new preview selected the identical five images
before the successful apply. Free Docker-filesystem space increased from
21,885,476,864 to 22,559,055,872 bytes (673,579,008 bytes net). Shared build cache,
sibling applications, containers, volumes and backups were preserved. A new image
preload still requires a fresh check of the deployment's 20 GiB reserve.

The verified CI image archive was 742,288,384 bytes uncompressed. After preload,
available space was 21,184,892,928 bytes, below the unchanged 21,474,836,480-byte
rollout reserve, so cancellation/deployment did not start. A bounded inventory
identified 27 closed rotated nginx logs (607,882,736 content bytes). Under the
deployment and logrotate locks, every file was checked for unchanged identity and
absence of open descriptors, copied to the separate cold filesystem, fsynced and
verified by SHA-256 before removal from the root filesystem. Contents and a private
manifest remain at `/mnt/maxim-cold/archived-host-logs/nginx-20261011T111338Z`.
Active logs and rotation configuration were unchanged. This freed a net
606,244,864 bytes; the immediate free-space readback was 21,754,433,536 bytes.

## Fixed-scope recovery

The final owner proof at 11:02:48 UTC still identified the original 09:24 started
handler without its completion checkpoint. Absence of sampled DELETE observations
did not prove absence of effects, so no handler replay or fabricated completion was
used. Historical started handlers are not recovered by the acquisition wrapper.

Cancellation `4a508a4e-cab6-463b-a184-6a561c1fde61` used the immutable cutoff
`2026-10-11T11:15:40.513Z` and exact installed b29 source/image. The normal controller
ran from a clean b29 checkout after its own exact-SHA CI gate. It stopped and
restarted its captured fleet, projected 304 receipts to CANCELLED, removed 108
selected BullMQ jobs and retained zero locked jobs. The host journal reached
COMPLETE; original receipts, claims, error/uncertainty evidence and publication
schedules were preserved. Cancellation is abandonment, not successful processing.

The normal c727 shared-image deployment then passed its unchanged disk preflight
with 21,741,363,200 bytes available and selected every API role. Release identity and
post-release acceptance will be recorded after strict smokes and fresh observation.
