# Required-subscription membership outage after notification

All times are UTC. AntiDuplicate remained OFF at revision 6 during diagnosis; its return was
postponed by the operator. This incident is separate from the earlier source-404 notice fix.

## Evidence

At 08:15:33 readiness returned 503 with operational queue age 1,309 seconds. PostgreSQL and
Redis were available; the one-minute action sample contained 1,463 successes and eight failures.
These aggregates do not prove the cause of every delayed receipt or total fleet interruption.

The observed runtime was `629ae6917dd120bcafd67eca729fe15e7ec1d717`, shared API image
`sha256:e6f5d50e2c8763b35db6eec2c067267c4e7de37543b62667db05e04b50db7baa`.
A bounded log sample over 07:50:00–08:22:00, without truncation for the eight inspected queue
roles, recorded a failure at 07:59:13.730 in `required-subscription.delete-authority` with
`subscription_membership_unavailable`. The exact owner audit at 08:19:35 selected a 07:59:10.444
predecessor with a started READY execution, no lease and no completion checkpoint. That audit
does not prove absence of previous effects and does not authorize replay or settlement.

The activity sample showed no long-running query/transaction. The generic queue-count audit
hit its statement timeout twice; it did not produce a usable count. Enqueue logs showed
independent progress and short SQL selection samples. Separate channel-edit executor-proof and
completion-claim failures were observed; this correction does not claim to fix those paths.

## Reproduced defect and correction

After a required-subscription notification or media coverage is committed, the handler checks
membership again before creating its DELETE intent. A transient unavailable membership result
threw before that durable handoff. The started handler could not safely replay its earlier
notification/sanction, so following messages in the same chat remained behind its ordering fence.

The guard now identifies this exact unavailable membership result with a dedicated error type.
Only the post-notice, pre-intent boundary catches it. It rechecks notice ownership and persists
the exact guarded DELETE intent, including the original source, reason and five-minute deadline.
Only a committed executable, non-ambiguous result lets the handler finish. Queue wakeup failure
leaves the SQL obligation for the existing sweeper. No new queue, longer deadline, repeated
notification, sanction or fabricated deletion receipt is introduced.

The worker still requires fresh negative membership, current policy, source and executor proof.
Membership restoration or policy disablement prevents deletion. Initial qualification, notice
source 503/member failures, arbitrary lookalike errors, storage failure, missing/off/shadow
handoffs, lost notice leases and ambiguous outcomes retain their failure behavior. Existing
started webhooks are not replayed or automatically rewritten by this fix.

## Validation and production acceptance

Before the correction the three new native cases failed with the same membership error, while
the 26 existing cases passed. After the correction, 298 focused checks passed in 12 suites with
disposable PostgreSQL 16 and Redis 7 and no skips. Four native variants cover still-missing
membership, restored membership, disabled policy and a lost BullMQ wakeup recovered from SQL.
They verify following same-chat receipt progress while DELETE remains paused, one notification,
one strike, retained source deadline and no canonical handler replay.

Deployment, any explicitly authorized abandonment of old receipts and closed fresh-cohort
measurements must be recorded separately. Local tests are not proof of production recovery.

## First deployment and cancellation

The membership correction reached all 14 API roles and both native auxiliaries in source
`24c2d84fd6fccbd0b214654ac5d64a3ad2a0a902`, image
`sha256:840ccc6fbdcbf0fcf471ce8afb496eb2d6a23d69e6fc87a9c79acbc7cae7bf3f`.
Exact-SHA Required and CodeQL passed. The image was preloaded from CI because the Docker
filesystem was below the clean-build reserve. Deploy installed the exact fleet but timed out
on readiness; no current release manifest was finalized.

Authorized cancellation `d8248536-610d-4254-b689-997d40fe3569` used the fixed cutoff
`2026-10-10T10:15:43.604Z`, the earliest new API generation start. A SQL timeout and then a
Docker inventory race interrupted it. Repeating the identical request completed the host
journal and restarted the captured generations at approximately 10:29. The successful client
pass projected 106 receipts and removed 244 jobs with zero retained locked jobs; the final
idempotent repeat projected/removed zero. These are per-pass counters, not an asserted total
of all receipts across interrupted attempts. User settings, statistics, connected entities,
publications and uncertain action evidence were retained.

At 10:34:22 all 14 roles still matched the exact image, with no restarts, paused queues or
queue owner. Both native auxiliaries were healthy. Readiness nevertheless remained 503:
oldest RECEIVED was 10:20:42.118, and operational lag was 824 seconds. A closed receipt cohort
10:30:30–10:30:35 sampled all 154 receipts without truncation: 76 PROCESSED, 22 DUPLICATE,
46 NO_REPLAY_HELD and 10 still RECEIVED. Completed-only p50/p95 were 18.2/40.6 seconds;
21 distinct chats had processed receipts. Cancellation succeeded; sustained recovery did not.

## Additional failure found during acceptance

At 10:21:33.069 the new runtime recorded a source GET 404 in
`required-subscription.delete-authority`, after notice handoff. At 10:40:37 the oldest received
mirror referenced a different canonical owner with a started READY claim, no lease and no
finished checkpoint. This does not establish absent effects or permit replay. A separate
`violation-delete` executor-proof rejection was recorded at 10:33:48.540.

The follow-up correction classifies exact source GET 404 or a typed missing-ID response only
in an explicit pre-intent DELETE handoff context. It uses the same committed durable-intent
requirement as unavailable membership. Initial and final-dispatch authority remain separate;
404 is never a deletion receipt. Source 503, member lookup errors, unknown/mutating errors,
storage failure and lost notice ownership retain their fences. Native regression variants
prove next same-chat progress, one notice, no handler replay, fresh resumed source/membership
checks, policy revocation, and SQL-sweeper recovery after a lost queue wakeup.

A separate retry diagnostic at 10:45:40 found an unstarted `message_removed` receipt created
10:37:23 with a preparation-lease error. Preparation histograms over 10:40–10:46 had no
samples above five seconds, so generic 30-second lease expiry is not an established explanation.
Do not attribute this family to the corrected subscription error or hide it with another drain.
The 15-minute monitor after restart did not meet the sustained lag-below-ten-seconds criterion.
Follow-up rollout, cancellation and final acceptance must be recorded separately.

## Reproduced cancellation-reader mismatch

The retry family was reproduced with a real cancelled message followed by its official
`message_removed` observation. Object-based admission (`backlogSource`) deliberately applies
message-family tombstones only to created/edited messages. The final SQL execution transition
applied that same tombstone to every event type. Admission therefore accepted the removal,
but READY publication failed with `Webhook preparation lease was lost before READY`, despite
fresh preparation. The native reproducer failed on that exact error before the correction.

The SQL predicate now uses the same event-type eligibility as object admission. Exact semantic
cancellations remain effective for every event type. A fresh removal now settles its observation;
the whole-engine message hold still preserves local duplicate history and denies remote effects.
Created/edited copies of the cancelled message remain denied.
Fresh callback identity remains independent from a previous message-family cancellation.
The native regression checks SQL/object agreement and the real preparation/worker path while
preserving the original CANCELLED receipt. The source-404 fix and this predicate correction
must be deployed together before assessing the remaining old started heads.

## Second deployment: transient improvement, then source-read timeout

Source `710cefecfe1946f6e83403f6305df9081b81eb0c`, image
`sha256:77e3c0155edd40d3a88284247846c6da8c42d0d91af2ae34a59301e3a8fd219f`
converged across all 14 API roles and two native auxiliaries. Required and CodeQL were green;
CI preload avoided a clean build below its disk reserve. The interrupted release journal caused
normal component reconciliation, including both static components. Readiness timed out and the
current release manifest remained unfinalized.

Cancellation `4d810e0a-cbfa-4efc-9020-3658fd21fd10`, fixed cutoff
`2026-10-10T11:54:23.695Z`, completed in one successful pass: 64 projected receipts,
86 removed jobs, zero retained locked jobs. A closed 12:04:32.695–12:04:37.695 cohort contained
66 receipts without truncation: 46 PROCESSED, 20 DUPLICATE, no pending or failed receipts.
Eleven invalid-clock exclusions (including five processed receipts) limit timestamp coverage.
Completed-only valid-clock p50/p95/max were 580/974/1,111 ms. This was short improvement only.

At 12:09:12.933 a new handler failure appeared in `required-subscription.follow-up`, GET messages
collection, no HTTP status. Its adjacent MAX failure diagnostic at 12:09:12.929 identified
`ECONNABORTED`; the original execution diagnostic did not allowlist this code. A bounded owner
audit at 12:13:36 showed a new 12:09:06.997 FAILED predecessor with business start
12:09:07.541, no lease and no finished checkpoint. Lag grew again. The 15-minute sustained
acceptance criterion was not met; the broad follow-up stage alone cannot distinguish a sanction
qualification from a notice handoff. No started handler was replayed or marked successful.

The next correction covers an exact source GET transport outage before a notice handoff, and
before its subsequent durable DELETE intent. Only a finite no-HTTP transport-code set without
mutation markers can defer. The SEND keeps its serialized original source/policy/deadline and
must actually be accepted by the normal guarded action path; failure does not settle the handler.
The independent executor still rejects unknown source, renewed membership, changed policy and
expired authority before any POST. DELETE requires its committed executable intent and fresh
worker authority. Sanctions, HTTP 503, unknown failures and attempted mutations retain their fences. More specific sanction/notice-plan/notice-handoff stages and
an allowlisted ECONNABORTED diagnostic make future failures attributable to their real boundary.

Validation, rollout and sustained acceptance of this additional correction are recorded separately.

At 12:13:02.774, the 12:10–12:27 bounded log window also identified a separate typed
`subscription_membership_unavailable` in `required-subscription.initial-authority`. The fresh
leader has not claimed the feature violation or begun a sanction at this exact boundary.
Its typed unavailable membership or source transport outcome now finishes without sanction,
notice, DELETE or active-mute fallthrough, retaining an explicit fail-open stage diagnostic.
This matches the existing initial membership/source-unavailable policy and does not catch
arbitrary errors or allow a later mutation failure to masquerade as initial qualification.
Both new initial native cases failed before this correction and verify mirrored settlement,
no feature effects, following same-chat progress and no started-handler replay afterward.

Local validation of the expanded change passed all 40 native full-path scenarios. The combined
run had one outdated unit expectation that still required an initial membership outage to throw;
its replacement joins the existing muted/unmuted pre-write matrix and retains every no-effect
assertion. Unknown lookalike errors and later boundaries keep their negative assertions.

## Notice membership and legacy executor rejection

A second bounded window, 12:27:00–12:58:00 on the same `710cefec` fleet, contained two
additional failures, with no log truncation across the eight inspected queue roles:

- At 12:29:06.445, `required-subscription.follow-up` reported unavailable membership. The
  built guard location identifies the notice guard's fresh-membership read, before SEND handoff.
- At 12:42:10.052, `violation-delete` failed at the final executor-proof check after quota wait,
  before the HTTP DELETE. The built handler location identifies the legacy inline deletion path.

The notice correction defers typed unavailable fresh membership through the same serialized,
independently guarded SEND handoff as a source-read outage. Its own worker still checks fresh
membership before POST. Terminal target rejection, failed handoff, expired authority and
attempted or ambiguous sends retain their distinct outcomes.

Legacy deletion now tries the next already eligible bot only for the genuine pre-dispatch
executor-proof rejection. The finite candidate pass neither retries a member mutation nor
records access loss from a superseded proof. If all candidates decline before dispatch, the
result remains an unsuccessful deletion; the rule path must not record a strike or issue a
follow-up sanction/notice. Its execution can finish without blocking subsequent chat events.
Unknown, unmarked, attempted and ambiguous failures remain fenced. These changes cannot settle
or replay the previously started failed handlers; authorized cancellation remains separate.

Both defects failed their new focused tests before correction (three failing cases). The first
native run passed 45 cases and exposed one incorrect new test expectation: a rollout-off legacy
DELETE has no durable own-reason receipt and therefore cannot authorize a new strike/notice even
when a peer deletes successfully. The test now explicitly requires no new strike or notice in
both peer-success and all-refused variants; runtime sanction guards were not weakened.
Final focused validation passed 344 tests in 13 suites with no skips, including all 46 native
full-path cases on disposable PostgreSQL 16 and Redis 7. Production rollout and sustained
recovery remain unverified at this checkpoint.

## Third deployment: final-dispatch membership outage

Source `fca2f9f326e2fb112802af83f4ac046131958280`, image
`sha256:71d9b51b6dfd3b2c7c553a00062d86c76aaf85a4733fb12bb595cc8a68007fe8`,
converged across all 14 API roles and both native auxiliaries after green exact-SHA CI.
Cancellation `fb204db8-c2e0-4082-b068-3949a9ec38c2`, fixed cutoff
`2026-10-10T13:55:24.218Z`, completed in one pass: 52 projected receipts, 68 removed jobs,
zero retained locked jobs. The early closed 14:04:41–14:04:46 cohort eventually contained
88 PROCESSED and 47 DUPLICATE receipts with none pending/failed, no truncation or invalid clocks.
Its completed-only p95 was 136.672 seconds during warmup, not healthy latency.

Lag briefly fell below ten seconds, but only 361 continuous seconds met normal-mode acceptance.
The bounded 14:09–14:18 log window captured another membership-unavailable failure at
14:17:03.278. Exact built source locations identify the last `beforeDeleteMutation` authority
check, after intent persistence. By 14:29:11 operational lag had grown to 589 seconds.
Cancellation completed; sustained recovery and release finalization did not.

The native reproducer makes membership unavailable only after the exact DELETE intent exists
in PostgreSQL. All four new outcome variants failed on the old inline path. The correction now
hands every production post-notice DELETE to the durable worker, including when the initial
handoff check succeeds. It no longer invokes that intent inline from the started webhook.
Final source, membership, policy and deadline guards remain in the worker; storage failure,
non-executable/ambiguous handoff and lost notice ownership still fail closed. No DELETE receipt,
notice replay, longer deadline or successful remote action is inferred from persistence.

Initial focused validation passed 356 checks in 13 suites, including 50 native full-path cases.
An additional worker-outage assertion verifies retained SQL retry authority without reopening
the completed webhook. Production rollout and sustained acceptance must be recorded separately.

## Fourth deployment: ordinary DELETE still outside durable routing

Source `ca2f021a3521cc33b2529c6cfe54d4062bcd802e`, image
`sha256:89eb28698a4ff9f47891473a9697096884a7d4c1839b85ab74c3d34bf350e099`,
converged across all 14 API roles and both auxiliaries after green exact-SHA CI. Cancellation
`3b183528-0485-4d9e-bb76-cef80a327bce`, cutoff `2026-10-10T15:14:33.157Z`, completed:
13 projected receipts, 12 removed jobs, zero retained locked jobs. Readiness did not recover.

The bounded 15:14:33–15:23:30 UTC log window captured a handler failure at 15:17:21.896 in
`violation-delete`: `ECONNABORTED`, operation `delete_messages`, collection target, no HTTP
status. The 15:23:59.495 exact-owner audit found the FAILED 15:15:01.057 predecessor with a
15:17:19.626 business start, no live lease and no finished checkpoint. The following RECEIVED
receipt was created at 15:17:09.118. Neither absence of a DELETE observation nor the timeout
proves whether MAX applied the mutation. The cancellation correctly excluded this post-cutoff
source; replay or invented completion would be unsafe.

The base delete-intent rollout was `canary` with two chats. Current user-delete guards therefore
had inconsistent behavior outside that cohort: content rules could fall back to legacy inline
DELETE, while closed-chat and stateful rules refused that fallback but had no executable durable
intent. The native timeout reproducer failed in canary/shadow/off and passed in on.

The correction makes the finite `DURABLE_USER_DELETE_RULES` set independently executable at
admission, exact intent loading and indexed due selection. It does not change per-chat settings,
base cleanup recovery, duplicate authority, OCR or retention ceilings. OBSERVED history is not
promoted by a sweep. Current source/policy/author/deadline checks still gate every new mutation.
Only a built-in pre-dispatch guard failure may leave a committed retry and finish its inline
caller: exact live lease CAS and absent mutation markers are mandatory. Caller callback errors,
lost leases, failed persistence and duplicate-specific boundaries keep their existing fences.
Unknown actual DELETE outcomes remain AMBIGUOUS; they neither authorize peer retry nor create a
strike or sanction receipt. Validation and production acceptance follow separately.

Focused validation passed 465 tests in six suites with no skips using disposable PostgreSQL 16
and Redis 7. Coverage includes all four base modes under unknown DELETE, original-deadline
source-read retry followed by real sweep/worker completion, next same-chat progress without
handler replay, closed-chat enforcement outside canary, strict lease/persistence refusal,
independent reason guards and correlated plan bounds with 50,000 retained intents/reasons.
The fixed production duplicate audit at 15:42:10 UTC emitted its capped settings sample, then
hit its statement timeout before the intent report; it is incomplete and proves no recovery.

The first GitHub run for `69d319cc84033454fee9ea897d3e80fc56e09a87` passed API, static,
images, consumers and CodeQL, but failed four of 1,225 PostgreSQL tests. Three stale-access
full-path expectations still required a handler exception after a committed DELETE guard retry;
they now require a completed receipt, no handler replay and the same later independently guarded
reserve-bot recovery, retaining all no-effect/no-strike assertions before permission proof.
The fourth failure was fixture teardown: deleting 801 dispositions together exceeded its
five-second statement timeout while PostgreSQL checked retained webhook foreign keys. Teardown
now deletes at most 100 owned disposition IDs per statement under a fixed page bound. Production
query budgets and runtime recovery code remain unchanged. Both repaired suites passed locally:
41 real-store tests, no skips. Exact-SHA CI and deployment still require completion.

The next exact CI (`084236f0a9eb61f11bc2c208de3525a2df0985fd`) passed 1,224 native
cases and failed the deferred-scope plan bound: 1,264 returned base-scan rows instead of
at most 260. The unchanged focused suite passed locally, while controlled stale-statistics
fixtures demonstrated that the planner could also use a non-leading index for exact ID probes.
The plan fixture now analyzes its replaced disposable table before measuring, as the existing
retained-history cases already do. The 260-row bound remains, and exact body accesses additionally
require primary-key probes. This changes only test
setup and assertions; no production planner settings, query budgets or runtime were changed.

Analyzing the tiny fixture alone did not stabilize the hosted planner: the `9e1dd1c3`
CI again passed 1,224 cases but chose a sequential scan in this plan test. The fixture
now measures the same unchanged query with 50,000 terminal historical receipts, analyzes
that representative relation and rolls back its own history before continuing admission
assertions. It retains the index-only/index-scan requirement, exact primary-key body probe,
260-row maximum and all independent-bot/scope-overflow assertions. No planner switches are
forced. The full focused native suite passed 37 cases with no skips; production recovery
still awaits successful release checks and actual rollout.

## Final queue recovery checkpoint, 18:21 UTC

The deployed source is `ab9b389233c2ea8ce2e33022d43cbc6dbe09e814`, API image
`sha256:3bd08a1880b93871ff60ec3909a65ae6f876f407425acf3110f3633e314a77fd`.
Exact-SHA Required and CodeQL passed (runs `38071459812` and `38071459756`). The CI
PostgreSQL lane passed all 1,225 cases. A separate full local run had two group-command
retention-count fixture failures (foreign retained rows); the sequential fleet/command
isolation run passed 37 + 37 tests. Do not report that full local run as green or weaken
production assertions to make fixture cleanup pass.

The shared image converged across all 14 API roles and both native auxiliaries; both static
components also converged. Deploy then stopped at readiness because the old backlog remained.
The unchanged deploy was not repeated. Cancellation
`e4a707c7-e1e5-46c3-9f97-59c066ea14cc`, fixed cutoff `2026-10-10T17:48:17.438Z`, completed:
six projected receipts, 32 removed jobs, zero retained locked jobs. Services were restored around
17:55 UTC. Cancellation preserves user data, original claims and uncertain effects; these counts
are abandonment results, not successful moderation or permission to repeat the operation.

After queue recovery, `vps-connect.sh finalize-release-recovery main` passed exact-SHA CI,
stable runtime/fence observations, migration inventory, API/static readiness and native OCR
isolation/raster smokes. It recorded
`release-finalized-20261010T182125Z-ab9b389233c2-557333` without recreating the runtime.
This is the completed release identity; do not resume the earlier failed deployment journal.

### Observed queue and moderation results

- Readiness was continuously healthy in 61 samples from `18:01:40.287` to `18:16:44.034` UTC
  (903.747 seconds, roughly 15-second sampling): normal mode, healthy PostgreSQL/Redis,
  raw/operational queue checks passing, no burst, lag 0–8.533 seconds. Final lag was below
  one second. This is sampled evidence, not uninterrupted observation between probes.
- The closed `17:59:30–17:59:35` receipt cohort contained 42 events: 36 PROCESSED and six
  DUPLICATE. The closed `18:12:00–18:12:05` cohort contained 47: 40 PROCESSED and seven
  DUPLICATE. Both were complete under the 256-per-status cap, with zero RECEIVED, QUEUED,
  FAILED, CANCELLED or NO_REPLAY_HELD. Completed-only p95 was 467.5 ms and 555.45 ms,
  respectively. Invalid-clock counts were two and one: preserve those exceptions and do not
  assert the helper's stronger independent-group acceptance, which remained false. Both
  reports followed reviewed plain indexed plans; neither proves remote effects.
- At `18:14:48` all 53 registered Redis queues were unpaused and webhook transport queues
  had no waiting/active work in that snapshot. Night-mode had zero due/waiting/active jobs
  and 5,148 future transitions. Delete intents had 89 prioritized and two active jobs;
  the 32-job queued sample was at most 7.842 seconds old, active locks were present and
  neither job had run for 0.1 seconds. This queue was serving current work, not empty.
- The fixed moderation-outcomes audit at `18:18:55.710763` returned its capped 512 latest
  events, spanning `18:05:27.714–18:18:52.871`: at least three remote-confirmed mute
  enforcement deletions, four remote-confirmed administrator bans and 19 installed bot
  mutes. The sample was truncated; installation alone does not prove mute enforcement,
  every attempt, current mute state or every chat's health. No diagnostic messages were sent.
- The complete bounded log sample `18:05:00–18:17:00` had no new classified webhook
  handler/preparation failures across the 14 roles. Enqueue samples separated selection
  (27–115 ms in the final captured batch samples) from enqueue/preparation work; recorded
  work-unit errors were zero. Temporary ordered-head/preparation waits still occurred.
  The five-second cohort's separate metrics window contained no log rows and is not a
  throughput measurement; the longer phase sample also lacks a full ingress denominator.

### Remaining observations, not cleared by this recovery

- OCR recycled twice at `18:04:29.840236679` and `18:16:15.515417523` UTC after
  `native_timeout` during recognition, with zero pending bytes/queue depth. It returned
  healthy; current inspection reported no OOM. Photo sandbox restart count was zero.
  The first monitor required absolute fleet restart count zero, including auxiliaries, so
  it correctly exited 2 with `accepted=false` despite the 903.747-second healthy queue
  interval. Preserve that result. The later finalizer independently proved stable runtime
  during its smokes; it does not turn the earlier monitor into a pass. Never recreate a
  sandbox merely to zero a diagnostic counter or disable its mandatory timeout containment.
- Between `18:00:56.867` and `18:00:59.721`, eight critical-role handler failures at stage
  `start` pointed to built `max-client.service.js:5364`, the pre-dispatch
  `MaxApiInternalRateLimitError`. There were also 18 private-control warnings with callback
  and bad-request metadata between `18:00:47.342` and `18:00:59.088`; their underlying
  application error was not classified. Do not label all 18 as rate-limit failures or
  replay started private handlers. No recurrence appeared in the later bounded log window.
- Publisher binding refresh still had 1,004 prioritized maintenance jobs and two live
  workers (down from 1,103 at `18:02:15`); its short queued sample reached about 1,053 seconds
  of creation age. VK sync had five waiting/two active jobs. The later log window contained
  89 `VK sync post autopublish enqueue failed` warnings and four bounded schedule-limit
  warnings. Publisher/VK recovery is **not** established and was deferred by the user.
- Other captured warnings included 40 missing-poll verification and 40 poll-render failures,
  13 durable night-mode reconciliation retries, eight send-side auto-delete presence-check
  failures, six unresolved subscription checks failing open, and two moderation skips for
  missing MAX permissions. There were also unclassified warnings. Their counts are not
  distinct chats, fresh blockers or proof of successful effects; retain them for targeted
  follow-up rather than declaring every module error-free or clearing unrelated queues.
- Anti-duplicate remains deferred. This task did not enable it. At the user's request,
  stop after queue verification and recording successes/errors; do not expand this checkpoint
  into a Publisher, OCR, private-menu or poll repair wave without a new request.

Private evidence is under the operator state directory `queue-recovery-20261010`, with the
final sanitized role sample under `antiduplicate-return-20261010`. Keep raw content, identifiers,
tokens, request snapshots and local exports out of Git. The durable prevention rules are in
[webhook latency prevention](../runbooks/webhook-latency-prevention.md), already required by
the root agent notes before scheduling, execution handoff or backlog changes.
