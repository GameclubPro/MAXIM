# Webhook latency recovery review, 10 October 2026

Production processing recovered in the recorded short windows after runtime fixes and bounded
cancellation. This review preserves the evidence and the mistakes that prolonged recovery; it
does not establish continuous fleet/product acceptance. All times below are **UTC** (Moscow +3).
It is historical evidence, not a live status page or standing authorization for maintenance.

The durable rules and regression matrix are in
[Preventing webhook stalls and unsafe recovery](../runbooks/webhook-latency-prevention.md).

## Scope and confirmed causes

This was a chain of scheduling, SQL and execution-state defects. There is no evidence that a
Redis reset, blanket lock removal or unlimited concurrency would have repaired it safely.

| Layer                               | Confirmed evidence and correction                                                                                                                                                                                                                                                                                                        | Limit of attribution                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Earlier selection/admission defects | The [3 October review](2026-10-03-queue-backlog.md) records reproduced reservation leaks, polling gaps, expensive historical recovery and delete-intent scans                                                                                                                                                                            | Their individual contribution to total user delay was not isolated                                    |
| Work held across polls              | The [6 October review](https://github.com/GameclubPro/MAXIM/blob/dc52b5e4ac45d8980f901b957c234440f517b518/docs/operations/incidents/2026-10-06-legacy-queue-recovery.md) reproduces waiting for a whole active batch before selecting independent work; correction retains bounded in-flight work across polls                           | Completing a small cold-recovery scope did not restore the whole fleet                                |
| Preparation and observation proofs  | The [8 October review](https://github.com/GameclubPro/MAXIM/blob/dc52b5e4ac45d8980f901b957c234440f517b518/docs/operations/incidents/2026-10-08-preparation-throughput.md) reproduces idle slots during selection, an impossible ordinary-executor requirement for `bot_added`, and dormant observations misclassified as prior execution | Independent unknown-action/replay fences still required separate treatment                            |
| Atomic receipt writes               | On the `7f16c5f2` baseline, a ten-second sample showed about 10,600 PostgreSQL calls and 1,400 transactions, including repeated BEGIN/COMMIT around single updates; `44c69a66` uses atomic parameterized updates with status/CAS and JSON no-op guards                                                                                   | This is sampled DB work, not a fleet throughput denominator; multi-step transactions remain necessary |
| Persisted subscription notice       | Exact source GET 404 at the final authority callback escaped from a persisted notice/album handoff, leaving a started execution incomplete and blocking later same-chat work; `629ae691` finishes only the exact typed no-dispatch rejection from its own callback                                                                       | This does not prove that every historical head had this cause or that the source message was deleted  |
| Cancellation selection              | The first normal selector spent its bounded budget walking terminal FAILED history; `629ae691` selects RECEIVED/QUEUED through the full status/created/id index and pending/retrying FAILED message heads through the existing partial ordered-head index                                                                                | Historical nonmessage FAILED receipts are outside this cancellation scope                             |
| Snapshot persistence                | A Redis job containing a lone UTF-16 surrogate could not be inserted directly as PostgreSQL JSONB; a lossless `BULLMQ_JOB_JSON_UTF8_BASE64_V1` envelope preserves serialized job JSON                                                                                                                                                    | This was a maintenance-path incompatibility, not evidence of Redis data loss                          |

The fixed cancellation selector materializes 200-row raw pages, retains the raw cursor before
cutoff/eligibility filtering and reads payloads by primary key. It includes null chat keys and
skips already installed dispositions. Transaction-local planner controls and disabled JIT keep
these repeated maintenance reads on reviewed plans; they are not global PostgreSQL settings.
Local real-store regressions include 10,000 terminal FAILED rows and tied timestamps.

The notice correction makes no send, delete or delivered-coverage claim on authority denial.
Persisted feature/violation evidence survives. Source 503, member GET 404, lease loss, attempted
or ambiguous mutations and errors after successful authorization still fail closed. The whole
started moderation engine is never replayed. The native regression proves that the next event
in that same chat can progress after the exact source-404 case.

Internal limiter startup errors and changed executor proofs were separately observed. Their
presence is not proof that they explain every blocker. The earlier capped completed-event
baseline (about 32.8 s median / 109.7 s p95) is not a complete fleet percentile or a matched
before/after experiment.

## Release and cancellation identity

At finalization, all 14 API roles, both native auxiliaries and both active static components
ran source `629ae6917dd120bcafd67eca729fe15e7ec1d717`. The shared API image was
`sha256:e6f5d50e2c8763b35db6eec2c067267c4e7de37543b62667db05e04b50db7baa`.
All 24 webhook queues were unpaused without a rollout owner; verified restart counters were zero.

| Operation                              | Fixed cutoff               | Result                                                                                  |
| -------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `241ed402-25b7-4397-ada5-43bbc6fbb483` | `2026-10-10T04:30:46.788Z` | COMPLETE; 61,422 receipts projected CANCELLED, 856 jobs removed, 0 retained locked jobs |
| `7100540c-1277-44b2-81fe-dad04f482c2c` | `2026-10-10T07:01:27.000Z` | COMPLETE; 124 receipts projected CANCELLED, 102 jobs removed, 0 retained locked jobs    |

These are receipt and job counts, not unique users, chats or successful moderation actions.
The original completed journal was retained in its private content-addressed archive with
SHA-256 `6e04979d843ed229099d71f5309760c6a46ab0786b9656c65a8817eaa370a905` before the new
operation. The follow-up first failed during restart inventory when an ephemeral Docker object
disappeared between list and inspect. Resuming the identical request completed with zero
additional receipt projections or job removals. The cutoff and journal were not rewritten.
The inventory race remains an observed tooling limitation, not a claimed fix.

No Redis flush or user-data cleanup was performed. Connected entities, settings, statistics,
publications, original webhook/error evidence, claims and ambiguous actions were preserved by
the cancellation protocol. AntiDuplicate stayed off; this recovery did not enable it.

The release was finalized at 07:26 without container recreation:
`release-finalized-20261010T072616Z-629ae6917dd1-3650617`.
Strict API live/ready, public/static, native sandbox, exact-image, released-fence and stability
smokes passed before the manifest was committed.

## Recovery evidence and its limits

Startup occupied all twelve preparation slots. Observed backlog age moved approximately
330 → 150 → 191 seconds before draining without another cancellation or capacity increase.
Slot saturation and one upward sample were insufficient reasons for another restart.

| Closed receipt-created window        | Full recorded status counts                              | Completed-only processing latency                                        |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| 07:19:00–07:19:05                    | 131 total: 81 PROCESSED, 50 DUPLICATE; no pending/failed | p50 902 ms; p95 1,641 ms; maximum 2,523 ms                               |
| 07:24:00–07:24:05, observed 07:24:46 | 142 total: 89 PROCESSED, 53 DUPLICATE; no pending/failed | p50 997 ms; p95 4,168.65 ms; maximum 6,468 ms; 6 invalid clocks excluded |

At 07:20:42 and 07:24:02 both readiness endpoints returned 200 and current queue lag was about
2.1–2.3 seconds. The 07:24 one-minute MAX action window recorded 1,286 successes and zero
failures. Action counters are separate from the receipt cohorts; neither identifies every
bot/product effect. A premature 07:23:57 report for the future 07:24 cohort is excluded from
evidence. Only the later closed-window measurement is admissible.

These samples establish short-window operational recovery, not fifteen continuous minutes of
low lag, every product's delivery correctness or freedom from future stalls. The sustained
acceptance requirement in the recovery runbook is unchanged and is not proved by this record.

## Delivery and validation exceptions

Runtime source `629ae691` did **not** have fully green exact-SHA CI at deployment/finalization:

- API and CodeQL passed. The native lane passed 70 suites / 1,190 tests but failed one existing
  test that still expected the old source-404 stall.
- Static CI encountered a Node subprocess abort in an unchanged
  `participant-reports-deploy-guards.test.mjs` rollback fixture. Local infrastructure validation
  passed (2,511 passed / 20 skipped); this does not retroactively turn CI green.
- Deploy used an explicit recorded emergency bypass/reason. Cancellation and finalization used
  reviewed direct host entrypoints because the connector gates required green runtime CI.
  These are incident exceptions, not the routine procedure or future bypass authorization.

Test-only source `dc52b5e4ac45d8980f901b957c234440f517b518` corrects the native expectation while
retaining the 503 fence, persisted evidence, next-event progress and no replay. It does not change
production runtime. Before this review was submitted, its CodeQL run
[38034316291](https://github.com/GameclubPro/MAXIM/actions/runs/38034316291) and full
[CI run 38034316287](https://github.com/GameclubPro/MAXIM/actions/runs/38034316287), including
the native lane and Required, completed successfully. That success belongs to `dc52b5e4`;
the recorded emergency CI exception for the installed `629ae691` source remains explicit.

Local evidence already included 260 focused notice/callback tests, 7 real PostgreSQL/Redis
cancellation tests, 26 native moderation-guard tests after the expectation correction, API
typecheck, focused lint and the infrastructure validation above. Documentation work does not
require another production rollout or repetition of those passed runtime tests.

Reviewed changes: [PR141](https://github.com/GameclubPro/MAXIM/pull/141) for atomic receipt
throughput, [PR142](https://github.com/GameclubPro/MAXIM/pull/142) for notice completion and
bounded cancellation, and [PR143](https://github.com/GameclubPro/MAXIM/pull/143) for the native
regression expectation. Raw production exports and private diagnostics are not part of this review.

## What agents must do differently

- Diagnose the stage before changing resources. Compare ingress against useful fresh completions,
  SQL/preparation timings and exact ordering evidence. Do not attribute an entire fleet incident
  to one last-error marker or terminal FAILED count.
- Avoid repeated small cold-recovery cycles when the authorized objective is broad abandonment.
  Use the compatible bounded cancellation protocol, retain unknown effects, and fix the source
  of new failures before deciding whether another fixed cutoff is necessary.
- Require native full-path tests for notice changes. The 260-test focused pass did not include
  the integration test that still expected the old stall. Review every failing expectation against
  effects safety; never make a suite pass by dropping the negative case or skipping the test.
- Preserve interrupted operation identity and proof. Do not reset a journal, start another UUID,
  delete a lock or assume a vanished Docker object belonged to this operation.
- Separate deployment convergence from backlog recovery. The 900-second readiness waiter held
  the deploy lock while old blockers still needed cancellation. In this incident only its attested
  idle waiter PID was terminated after exact fleet/fence convergence, retaining the transition
  journal. This exceptional action is not a general instruction to kill deploy processes. Normal
  recovery must preserve owned-process cleanup, the shared lock and strict finalization.
- Do not restart a healthy exact fleet to record a manifest or install a test-only correction.
  Do not treat successful cancellation or one healthy sample as full acceptance. Keep closed
  cohorts, excluded clocks, remaining obligations and failed CI stages explicit in the handoff.

The durable safeguards are linked from root, API and infrastructure agent notes and the incident
playbook. Existing regression suites enforce the code invariants; documentation alone cannot
guarantee that no future incident will occur.
