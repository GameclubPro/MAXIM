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

The normal c727 shared-image deployment passed its unchanged disk preflight with
21,741,363,200 bytes available and recreated all fourteen API roles and both native
auxiliaries. It reused the verified image and found no pending Prisma migrations.
The rollout's queued ingress took several minutes to drain: a bounded RECEIVED
sample fell from more than 2,000 to 1,650, then raw lag fell from 334 to 196 seconds
and below three seconds. No second cancellation, capacity increase or readiness
timeout extension was used. Strict API/native smokes passed and committed release
`release-20261011T111904Z-c72721574284`, image
`sha256:581929a3e6b4b3747d758b9fc4960fbb1358203d224bc6cdde820342b1b5f0c4`.
Static components retained their prior image identities.

## Post-release observations

The first continuous observation began at 11:31:08.370 UTC. It failed at
11:42:07.746: raw oldest age reached 13.922 seconds while operational lag was
2.464 seconds and the readiness HTTP response remained 200. This is a failed
strict ten-second window, not sustained acceptance. A fresh read at 11:42:48
showed raw lag below one second and normal automatic mode. The failed window
is retained separately from the subsequent observation.

The second observation passed from 11:43:56.324 to 11:59:01.170 UTC: 181 samples,
904.846 seconds elapsed, no missing samples and maximum raw lag 7.85 seconds.
This confirms that particular continuous window below ten seconds; it does not
erase the earlier failed window or classify receipt outcomes by itself.

Six nonempty, complete closed receipt-created samples from 11:31:08.858 to
11:45:24.178 UTC contained 2,206 PROCESSED, 597 DUPLICATE and 29 FAILED receipts,
with zero RECEIVED, QUEUED, NO_REPLAY_HELD or CANCELLED rows and no invalid clocks.
Processed-only p95 ranged from 968.8 to 3,065 ms across these individual samples;
this is not a pooled percentile. All 29 failures occurred in the first two samples;
the following four had none. Their exact historical causes are not established by
the available schema-v1 cohort report. The bounded cohort report was extended in
`d4c20d6e2cad9883b8fa238a7277f0a450158c20` to expose fixed saved-error categories and
independent retry/quarantine/deadline counts without raw errors or identifiers.
Five focused checks passed, including real PostgreSQL with retained history and
512-row saturation in both PROCESSED and FAILED samples. This is diagnostic tooling,
not another API runtime change or replay authority.

Exact diagnostic-source Required (run `38136624488`) and CodeQL (run
`38136624441`) passed. The clean VPS source was fast-forwarded under the shared
deploy lock to d4c20d6e without recreating the c727 runtime. The reviewed plain
plan retained the status/creation index and bounded primary-key metadata probes.
The schema-v2 closed cohort at 12:06:46.825–12:07:16.825 UTC was complete and
nonempty: 417 PROCESSED, 256 DUPLICATE and zero rows in every other status, with
no invalid clocks and processed-only p95 1,386 ms. Its empty failure-family result
does not retrospectively classify the earlier 29 failures.

A separate bounded log read of 11:43:09–11:53:09 UTC found one preparation warning
without input truncation. It recorded attempt one and a scheduled two-second
retry, with no classified error code. The exact c727 image places its frame at
the transaction used to settle a prepared canonical mirror. The frame identifies
the operation, not the underlying database failure or that receipt's eventual
outcome; it does not authorize a business-handler replay.

All six moderation identities/subscriptions and Publisher's subscription/type
coverage passed again at 11:31 UTC; the 11:46 load snapshot showed activity for all
seven bots. The canonical mini app and its assets passed the HTTP smoke. The
11:40:48–11:46:58 capped moderation sample included 82 remote-confirmed mute
enforcement deletions, 46 administrator mute installations and five bot mute
installations. It covers only the latest 512 observations, not every rule/attempt.

Publisher logged 25 persisted delivery receipts during 11:30:54–11:40:54: eight
SLOTS, fifteen RECURRENCE and two NOW. The same window also contained missed-window
markers and one blocked deferral; these are not necessarily distinct publications.
No expired or uncertain publication was replayed. The sampled comment failures
included the same pre-dispatch setup/readiness refusal; protected action cleanup
continued to reject ambiguous message presence. Access/policy guards remained intact.

Read OCR counters from `api-media-analysis`: its native behavior scope differs from
the generic admin process. The admin-scope zero deltas collected initially do not
measure the media worker. In the verified media scope, 11:44:00–11:49:15 had nineteen
started and nineteen terminal analyses: eighteen COMPLETE_KEEP and one
TECHNICAL_INCOMPLETE with an OCR timeout; ten image stop-list checks completed
without a match. These are actual counter deltas, not historical totals or proof
that every image is analyzable. Native timeout containment remains mandatory.

The repeated duplicate catalog completed its capped settings sample and recent
moderation sample, then its delete-intent section hit the unchanged statement
timeout. The plain plan uses bounded per-status index reads and indexed reason
lookups; no scan widening, timeout increase or partial-as-complete claim was used.
No duplicate rule was observed in the complete one-hour moderation sample. Modes
that are disabled/shadow or received no suitable traffic have configuration/test
coverage only; this audit does not claim live execution of every product feature.

## Handoff readback

At 12:07:46 UTC, all fourteen API roles and both native auxiliaries were running
the manifest's exact c727 image. Both readiness endpoints returned 200 with
PostgreSQL/Redis available, normal automatic mode and raw lag below 3.4 seconds.
API and photo-sandbox restart counts remained zero. OCR had two native-recognition
timeout recycles since 11:31:08; its bounded lifecycle log classified both, without
truncation or unknown lifecycle events. It was healthy with no OOM. These mandatory
containment restarts and incomplete image analyses are not successful recognition.

Media-worker counters from 11:44:00.384 to 12:10:58.352 UTC retained the same metric
scope and showed 183 logical starts and 177 terminal outcomes: 171 COMPLETE_KEEP,
two TECHNICAL_INCOMPLETE (OCR timeout), three LEGITIMATE_SKIP (source unavailable)
and one EXPIRED (governor pressure). Image-text stop-list analysis completed 111
times without a match. All reported counter deltas were nonnegative. These are
interval deltas, not a joined closed cohort; outstanding work and cross-boundary
completions prevent interpreting their difference as a count of lost jobs.

The 12:09:33 census covered all 54 queue namespaces. Webhook queues had no fresh
failures in the preceding five minutes and only current active/prioritized work.
Night-mode and VK publication queues retained 5,112 and 2,282 future delayed jobs,
respectively, with none due then. OCR had two waiting, one active and four delayed
jobs, three already due; this instantaneous count alone does not establish a stall.
Roster had 42 prioritized and one active job, with no new activation failures.
Publisher refresh had 1,029 prioritized and two active jobs; its queue count is
not an obligation-deadline or delivery-success measurement.

The independently bounded 12:04:16–12:09:16 error sample covered 27 queues without
truncation. It found two Publisher-refresh HTTP 404s, three interactive-action HTTP
404s and seven guarded auto-delete refusals for ambiguous exact message presence.
No fresh webhook or roster failure was observed. The adjacent census uses a later
window, so its fresh-failure counts are not expected to match this sample exactly.
The ambiguous-action guards and future publication schedules were preserved.

Docker-filesystem free space at 12:07:46 was 21,569,048,576 bytes, only 94,212,096
bytes above the unchanged 20 GiB deployment reserve. Reviewed image reclaim and
closed-log archival freed 1,279,823,872 bytes net in their individual readbacks,
but ongoing growth and the preloaded image consumed part of that space. This is
not a durable capacity solution or assurance that a later rollout will pass its
fresh disk preflight. Shared caches, protected rollback history and backups were
not deleted. The temporary recovery checkout was archived after successful use.
