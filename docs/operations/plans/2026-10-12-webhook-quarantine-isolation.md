# Webhook fault isolation and release prevention

Status: implementation and verification in progress. Production remains unchanged until the
exact revision passes the checks below. Incident evidence:
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
   pending-quarantine predecessor or exact failed, enforced started owner with no completion. Record their identity, blocker, original receipt status,
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
- Ordered group commands in the affected chat retain the conservative dependency boundary;
  the mini app/administrative API remains available. Finer command/message isolation requires
  explicit effect dependencies, not skipping an unknown predecessor.

Validation, deployment and observation results will be recorded here after execution.

Development verification: the affected native regression matrix passed 1,191 tests across
14 suites after correcting the plan assertion to bound actual work at each EXPLAIN node
instead of prohibiting a harmless empty-result sort. Subsequent multibot-owner additions
passed all 305 tests in the four affected native/outbox suites. The initial broad API pass
completed 746 suites / 19,098 tests, with 2,154 store-dependent tests skipped; native coverage
is reported separately. Final staged validation and both production rollout phases remain
pending; these development results do not authorize declaring the rollout complete.

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
