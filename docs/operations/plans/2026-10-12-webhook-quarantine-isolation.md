# Webhook fault isolation and release prevention

Status: implemented and deployed as `dbd699740efaee890c78db39727df0148ee106fe`.
The recorded sustained window passed, but a later handoff check found a different unstarted
queued lifecycle delay; follow-up diagnosis is active and overall work is not closed.
Incident evidence:
[REG bot audit](../incidents/2026-10-12-reg-bot-audit.md).

## Why the releases did not prevent the incident

The Redis history operation had two different deadlines: a 250 ms server admission budget
and an identical client response budget. A command could commit inside its admission window
but return after the client deadline. Native delayed-response tests reproduced this before
`3ab9a7f4` corrected the reply budget. Earlier green tests did not exercise that boundary.
The generic MAX 404 receipt classification fixed by `eff4e674` was another distinct defect.
The later PUT timeout occurred with antiduplicate OFF; the available evidence does not prove
that the antiduplicate release introduced that transport failure.

The systemic defect was the treatment of an uncertain started handler: retaining its replay
fence was correct, but its chat successors remained active queue work. One old dependent head
could also affect global operational lag, degradation and release readiness. Admission tests
proved that other chats could enqueue, but did not prove their final execution in the same
fault experiment. CI and short release smokes were used before sustained observation; a green
release therefore did not certify this isolation property. Increasing timeouts or repeatedly
cancelling a larger time window cannot fix that architecture.

## Implemented boundary

1. Keep the original failed event, exact claim, unknown MAX effects and all durable child
   journals unchanged. Quarantine never constitutes success or authorizes original replay.
2. Park only positively unstarted ordered successors in the **same chat**, behind the exact
   pending-quarantine predecessor. An ordinary terminal failed, enforced started owner
   without completion quarantines only its pristine semantic copies; it must not invent a
   dependency for other messages in the chat. Record their identity, blocker, original receipt status,
   creation/deadline and quarantine time durably. Change their scheduling status to
   `QUARANTINED`, not PROCESSED or CANCELLED. Reject started/completed/leased/ambiguous sources.
   For a pristine physical multibot copy, retain the distinct canonical owner and first
   order anchor; require zero activation and no independent/legacy claims. An earlier copy
   must not conceal a later owner's failure, and positive owner completion must deduplicate
   copies without repeating its business work.
3. Recheck receipt and canonical claim under the same claim-before-receipt lock order as
   business start. Both preparation and final start refuse parked events. A stale BullMQ job
   may settle its scheduling obligation but cannot execute business logic.
4. Use bounded per-poll work and indexed selection. Parked events consume no active queue
   retry slots. Healthy chats, unrelated event types and the separate administrative API keep
   their existing capacity. This conservative boundary does not invent independence between
   ordered commands/messages in the affected chat.
5. Reconcile in bounded rotating batches. Only exact successful predecessor receipt/claim
   proof can restore a never-started successor. Preserve its original deadline and semantic
   identity. Expired work stays quarantined with an explicit expired reason; neither a TTL,
   terminal error nor an absent predecessor proves completion. Never replay a started handler.
6. Report quarantine separately from active lag, including bounded count/oldest age and
   truncation. Retain visible unresolved work; do not make dependency outages or genuine
   active backlog healthy. Retention cannot delete referenced evidence.

## Release contract

Mandatory native fault-isolation coverage must exercise a poison predecessor, multibot
copies, a real BullMQ scheduling handoff and final independent execution; delayed Redis
replies after commit; late success; timeout without completion proof; claim/start races;
expired deadlines; restart/repeated reconciliation; bounded work across retained history.
Tests must fail when parking/start fences are removed. Include the native suite in Required
CI, not only optional local commands. Preserve current unknown-effect negative tests.

Deployment requires local impact validation, green Required and CodeQL for the exact SHA,
compatible rollback readers, one shared API image across all roles and both native auxiliaries,
and strict deployment smokes. No PostgreSQL/Redis recreation, bulk cancellation or live test
messages. Observe closed fresh cohorts and a continuous 15-minute window after rollout;
report quarantined/failed/pending separately from PROCESSED and DUPLICATE. New uncertainty
must be contained and reported, not cleared to pass a release check.

## Acceptance and limits

- Zero extra remote attempts for the uncertain original, including after restart.
- Zero business starts for parked or expired successors.
- Fresh independent work completes while the original remains unresolved.
- Reconciliation preserves raw receipts, claims, action evidence and immutable deadlines.
- Native retained-history plans remain bounded; active queue lag cannot grow solely because
  work already parked in quarantine remains unresolved.
- Real provider/storage outages can still cause failures. This change bounds their spread;
  it cannot promise that errors never happen or infer the result of an unknown MAX mutation.
- Ordered group commands behind a pending timeout retain the conservative dependency boundary;
  the mini app/administrative API remains available. Finer command/message isolation requires
  explicit effect dependencies, not skipping an unknown predecessor.

Validation, deployment and observation results are recorded below.

Development verification: the affected native regression matrix passed 1,191 tests across
14 suites after correcting the plan assertion to bound actual work at each EXPLAIN node
instead of prohibiting a harmless empty-result sort. Subsequent multibot-owner additions
passed all 305 tests in the four affected native/outbox suites. The initial broad API pass
completed 746 suites / 19,098 tests, with 2,154 store-dependent tests skipped; native coverage
is reported separately. The later final staged validation and single fenced activation
supersede the initial two-deployment plan; development results alone do not certify production.

## Admission refinement from the live baseline

Before deployment, the read-only 13:03–13:04 UTC checks found an old never-activated
RECEIVED mirror with an elapsed deadline, whose different canonical owner was FAILED with
an enforced READY claim, a recorded business start and no completion. The saved error was
outside the timeout-marker family. Fresh 13:02:24–13:02:54 UTC traffic still completed:
457 PROCESSED, 188 DUPLICATE, no pending/failed sample rows; processed-only p95 was 961 ms.
This is evidence of stale dependency pressure, not complete recovery or proof of remote effects.
The native mirror fixture now also covers unclassified started-owner failure, with negative
cases for unstarted, completed and unenforced claims. No live receipt or claim was altered.

The writer-disabled compatibility commit is `c0c34f96`. It passed staged static/docs/infra,
API build/typecheck/tests and Prisma validation; final native schema drift also matched the
unchanged reviewed baseline. Retain its green exact-SHA image before activation. Because the
existing stale dependency already fails readiness, a reader-only deploy cannot honestly pass
strict release smokes. Use the documented single fenced activation path instead: all older
readers stop or are replaced before enqueue starts, with exact fleet/native verification before
queue release. The ordinary deploy controller and its mandatory regression tests already enforce
that order. No readiness exception, cancellation, direct database repair or manual manifest is
introduced. Finalization still requires strict smokes after the quarantine is enabled.

## CI wall-clock admission

Reader CI run `38254230153` completed all 1,320 tests in its 74-suite PostgreSQL race matrix
in 1,004 seconds, then passed the traffic, participant report, retention and final 20-test
moderation-rollup checks. The job's 20-minute overall limit cancelled completion of the last
step; Required correctly refused the release. The unfinished lane was retried, with the same
source and assertions. Future runs have a bounded 30-minute PostgreSQL job budget including
setup and all follow-up checks. No test, Required dependency, production timeout or readiness
threshold is removed or relaxed. This workflow-only adjustment does not change runtime code.

Activation run `38255892953` passed the complete PostgreSQL lane and every API step,
including Redis integration and cleanup, but its API job was also cancelled at the overall
20-minute boundary. Required again remained red. The API job receives the same bounded
30-minute wall-clock allowance; all assertions, native stores, teardown and Required checks
remain mandatory. Publish the workflow correction and require a fresh green exact-SHA run
before deployment instead of overriding either cancelled result.

Before activation, the multibot regression was extended through a second scheduling pass and
fresh same-chat business completion while the generic failed owner remains unchanged. This
exposed overly broad parking of neighboring events in that terminal-error case. Parking now
follows the existing scheduler boundary exactly: pending timeouts retain the chat barrier;
ordinary FAILED owners with no retry isolate only the exact pristine copies of their semantic
event. The paired negative case proves that new same-chat events behind a pending timeout
still cannot start. Neither change certifies or retries the failed original.

## Final candidate preparation

The writer-disabled compatible image source is `d6d841334ccf24d1351738549c457e01a21c9cf0`.
Its runtime is identical to `c0c34f96`; only workflow budgets and this plan differ. The old
20-minute PostgreSQL job timed out on its second attempt too, so the compatibility build
must pass its own revised CI instead of inheriting either cancelled result.

The final writer runtime and native tests are byte-identical to locally validated
`63c44c5a15594ba16876c0e150355280db6a13e9`. Merging the compatibility build retains its
history without replacing that verified implementation. Final local results: 746 API suites /
19,098 passed tests, 2,162 store-dependent skips; the separate native quarantine suite passed
21 tests including both terminal-mirror progress and the persistent pending-timeout barrier.
The earlier five-suite native matrix passed 274 tests. Both exact candidate CI identities,
image preload, deployment and the sustained readiness/active-lag window subsequently passed.

## Production activation

Both immutable API images were preloaded through the normal connector, with checksum and
exact Required/CodeQL verification. Compatibility CI `38262447860` and CodeQL `38262448035`
passed for `d6d841334ccf24d1351738549c457e01a21c9cf0`. Writer CI `38263225775` and CodeQL
`38263225780` passed for `dbd699740efaee890c78db39727df0148ee106fe`. No bypass was used.

The ordinary API-only deployment on 12 October ran at approximately 15:07–15:11 UTC with
the explicit 20 GiB Docker reserve and existing immutable image. It applied the additive
quarantine migration under the mandatory stopped-worker queue fence, then resumed queues
only after replacing all readers and starting enqueue last. Strict ingress/admin live/ready,
public live, both native boundaries and OCR raster checks passed. The committed manifest is
`release-20261012T150703Z-dbd699740efa`; all 14 API roles and both native auxiliaries use
`sha256:82a4197794db6e40e5bc4ebfe7cbde2b097cd96c3112bd955c587e6121fc7c9d`.
Antiduplicate readback remained FULL, revision 12, all enabled chats, permanent.

At 15:10:00 UTC, two retained receipts were already quarantined while another old active
head was still draining. The 15:10:18 owner probe had no predecessor; the next source probe
found only a fresh multibot copy with a positively completed canonical owner. Strict readiness
then passed without cancellation, manual status repair or a repeated deployment. PostgreSQL,
Redis, static services and sibling-project container generations were unchanged against the
earlier audit inventory. A separate Karavan worker was unhealthy at the initial inventory;
the final 15:46:16 inventory found every container healthy, with its same generation/restart
count. No Karavan mutation was performed and its transient cause is not established here.

## Closed production acceptance

The 15:31:50–15:46:55 UTC window contains 61 samples with complete coverage, maximum gap
16.014 seconds. Readiness, queue metrics and the released deploy fence passed every sample.
Active lag was p50 0.312 seconds, p95 1.762 seconds, maximum 3.032 seconds; no sample crossed
10 seconds. This meets the prolonged-backlog readiness/lag acceptance boundary. At the final
snapshot the system was normal/healthy, with two quarantined receipts and an unsaturated
quarantine sample. Antiduplicate remained FULL revision 12.

The unmodified capacity report still says **degraded**: 21 initial samples were in automatic
stabilization, and one sample caught the isolated OCR sandbox recycling at 15:37:17.461 UTC
for the fixed `native_timeout` reason. Its OOM flag was false and it returned healthy on the
same image; all 14 API roles retained zero restarts. The final inventory verified 14 exact API
roles plus both healthy native auxiliaries. This is not a zero-error OCR certification or a
claim that every sample had a stable auxiliary. No counter reset or container recreation was
used to change the observation result.

Seventeen nonoverlapping, complete, nonempty 30-second cohorts across 15:10:27–15:44:56 UTC
contained 5,268 PROCESSED, 1,689 DUPLICATE and 11 FAILED receipts. The other five statuses
were zero in those **fresh sampled cohorts**; the separate two historical quarantined receipts
remain retained. No cohort had truncation or invalid clocks. Per-cohort processed-only p95
ranged from 536 to 2,374 ms; these are not a combined percentile or all-window totals.
The 11 FAILED retained pending-quarantine metadata without a retry; they are not successful
moderation, confirmed absent effects or proof of regression from this release. New independent
work continued while those failures remained visible. DUPLICATE means mirrored/repeated
webhook delivery, not three duplicate advertisements counted against a user.

Twelve contiguous bounded log windows covered all 14 roles from 15:10:30 to 15:46:16 UTC,
without failed reads or saturation. They contained two handler/completion failure diagnostics,
zero duplicate-history-unavailable counters and maximum observed history phase 66 ms. Thirty
duplicate intent acceptances and 2,559 background completions are handoff/worker observations,
not confirmed deletion receipts. Eighty-one current-lookup refusals remained guarded. The final
60-second action snapshot had 1,931 successes, seven failures and two critical failures out of
1,938; these rolling counters must not be added across overlapping samples.

The initial 15:10:30–15:29:00 capacity report is retained separately: all readiness samples
passed, but intermittent active lag reached 25.637 seconds and stabilization persisted. A
later sample reached 28.392 seconds. During one spike the exact bounded queued proof saw a
new `user_added` event, READY/unstarted with no lease, not an uncertain failed predecessor.
The follow-up read-only Redis observation saw no recurrence within its three-minute bound;
it does not establish the original job's state or diagnose every spike. Thresholds and queue
contents were not changed to obtain the later acceptance window.

The release addresses the demonstrated shared-dependency blocker and its prevention gates.
It does not promise provider availability, zero individual failures, replay safety without
positive receipts, or unconditional progress for genuinely dependent ordered operations.
Reviewed raw monitor streams are removed after retaining these sanitized aggregates; durable
production failure, claim, action and quarantine evidence remains intact.

## Post-window handoff regression

At 15:54:20 UTC readiness was 503 with active lag 41.975 seconds; database and Redis were
healthy and quarantine remained at two. At 15:54:54 the bounded queued proof saw a fresh
`message_removed` receipt from 15:53:38.569, QUEUED with one activation and an enforced
READY/unstarted claim, no business lease, retry, error or predecessor. This is a different
boundary from the quarantined unknown-effect owners. Lag later reached 98 seconds; one
head cleared and another similar delay appeared. Do not misrepresent the earlier closed
window as permanent recovery or quarantine positively unstarted work merely because it is old.
Further read-only SQL/Redis correlation is in progress. No new stop, cancellation, replay,
threshold change or runtime mutation has been performed during this diagnosis.

## Focused preparation follow-up

The handoff monitor observed a fresh failed background job during both later spikes.
Its exact exception was not retained before ordinary job recovery removed it. A 16:27 UTC
bounded Redis stream probe has no failed events in its sampled windows; those windows do
not cover the original incident. The 16:22 UTC live/ready checks passed again, active lag
244–271 ms, with the same two quarantined receipts. This does not identify the old failure.

Code review found a demonstrable gap: losing the conditional business-lease update threw
a generic error. The real static/dynamic workers therefore failed the BullMQ job while SQL
remained QUEUED, until the separate 20-second user-facing or 120-second background repair.
New native fault injection reproduced this failure for edit, join and dynamic message jobs;
the removal case additionally required the normal retention store in the test fixture.
The fix changes only this refused CAS to the existing one-second typed preparation deferral.
It does not replay SQL errors, handlers or command recovery, release another worker's lease,
renew deadlines, weaken final start checks or change stale repair/readiness thresholds.

Four native contention cases now cover background edit/removal, join and dynamic workers.
Each proves no failed job or business start during the competing lease, independent-chat
completion first, unchanged receipt deadline/activation, then one original completion and
no replay. Unexpected preparation failures now produce allowlisted diagnostics while
propagating the identical error; typed waits stay quiet. The focused real-store run passed
415 tests across nine suites, including quarantine and existing replay fences. This proves
the implementation defect and fix, not the unrecorded cause of every production spike.
Local staged checks, exact-SHA CI, guarded deploy and fresh observation are still required.

## Confirmed concurrent settlement deadlock

Before deploying the preparation follow-up, a bounded Redis stream read retained a failed
background event at 16:45:21.105 UTC. Its error positively classified as PostgreSQL `40P01`,
`deadlock detected`, during `updateMany`; it was not the busy-lease refusal. The job hash
had already been removed by ordinary recovery, so its lost stack is not reconstructed.
The matching eight-line PostgreSQL log window records the deadlock at 16:45:21.093:
one transaction updates `webhook_events` completion fields while the other updates the
READY canonical claim's `enforced` fence. Only allowlisted query shape/column metadata was
retained; no user content or SQL parameters are published.

`trySettlePreparedMirrorWithClient` locked the owner receipt before the claim, opposite to
checkpoint recovery/completion. A real-store deterministic race reproduced the same
`40P01` using actual prepared-mirror settlement and exact finished-checkpoint recovery.
The prepared-mirror fence now acquires the claim before the owner receipt, retaining every
predicate and result. Handler-finished checkpoint persistence uses the same order; a lost
receipt proof still rolls back the checkpoint in the same transaction. No whole-handler or
arbitrary transaction retry is introduced. The regression also completes an independent
chat during contention and checks exactly one original handler execution after convergence.

The 16:29:35–16:44:35 pre-deploy monitor stayed ready but included raw-age spikes up to
66.845 seconds; it is not a clean low-lag acceptance window. A captured 16:44:02 snapshot
distinguished raw age 17.352 seconds from operational lag 0.474 seconds with one positively
proven readiness wait. Later health at 16:45:43 returned to 0.368–0.390 seconds. These
observations must not be conflated with the earlier 15:54 readiness failure or with the
16:45 deadlock. Current production still runs `dbd69974` during follow-up validation.

The expanded native matrix passed 491 tests across nine suites (multibot full path,
quarantine, outbox, membership readiness and moderation). Expected ordered-predecessor
waits are explicitly excluded from the new unexpected-preparation error log. Broad local
validation and a new exact-SHA CI run precede any deployment of this correction.
