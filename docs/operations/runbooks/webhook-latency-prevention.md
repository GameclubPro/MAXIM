# Preventing webhook stalls and unsafe recovery

Read this before changing webhook selection, preparation, execution handoffs, retry/ordering
guards or backlog recovery. It is the durable checklist for the
[October recovery review](../incidents/2026-10-10-webhook-latency-recovery.md), not a reason to run
maintenance on a healthy fleet. Root and scoped `AGENTS.md` remain authoritative for delivery.

The reviewed fixes are in runtime `629ae6917dd120bcafd67eca729fe15e7ec1d717`; the native
notice expectation is corrected in `dc52b5e4ac45d8980f901b957c234440f517b518`. An older checkout
may lack these implementations or tests. Reconcile the reviewed source before editing it;
copying these notes does not install a fix or prove which version is deployed.

## Invariants that must survive a change

1. **Independent work progresses.** An unresolved head blocks its dependent ordering scope,
   not unrelated chats, bots, shards or fresh administrator commands. Keep one bounded selector,
   bounded work across polls, current eligibility reloads and same-chat exclusion. An unfinished
   operation keeps its slot until it really finishes; a polling timeout cannot release its authority.
   Refill available preparation capacity during selection and drain owned work before closing stores.
2. **Bound database work before expensive predicates.** A result `LIMIT` does not bound scans,
   sorts or correlated probes. Use indexed keyset pages with raw cursors retained before filtering,
   bounded materialization and primary-key payload reads. Keep due work separate from terminal
   FAILED history. Test representative retained history, timestamp ties and planner skew in real
   PostgreSQL; review a plain plan before a new production query. Never run live `EXPLAIN ANALYZE`.
3. **Keep atomic hot-path writes cheap.** Receipt-only/payload-only changes that fit one SQL
   statement should keep their conditional status/CAS and JSON no-op checks in that statement.
   Do not add BEGIN/COMMIT around a single atomic update. Multi-step invariants still require
   transactions; removing all locks or transactions is not a throughput correction.
4. **Distinguish denied dispatch from unknown effects.** For an already persisted required-
   subscription notice/album handoff, only the exact typed rejection produced by that handoff's
   own final `beforeSend` callback may finish without dispatch. Exact source GET 404 is unavailable
   notice authority, not proof of deletion. Preserve the feature/violation evidence, release the
   owned notice lease and record neither delivery coverage nor a deletion. Source 503, member GET
   404, lease loss, attempted/ambiguous mutations and a failure after successful authorization
   remain fenced. Never convert arbitrary errors to PROCESSED or rerun a started whole engine.
   After a successful required-subscription notice/coverage handoff, an exact typed unavailable
   membership result or explicitly scoped pre-handoff source-unavailable result may transfer only its DELETE obligation to the durable intent service.
   Require a committed executable intent with its original source, reason and deadline; missing
   persistence, shadow/off, ambiguous state or lost notice ownership still fails. The worker must
   obtain fresh membership and current policy before deletion. This is neither a DELETE receipt
   nor permission to replay the notification, sanction or original webhook handler.
5. **Observation is not execution.** A PROCESSED receipt can be a dormant-bot observation.
   Exclude only its exact validated marker with no linked claim; preserve the semantic anchor and
   every independent replay fence. `bot_added` must not demand an ordinary live executor or
   perform passive activation. Keep exact receiving-bot identity and the explicit denylist path.
6. **Cancellation preserves authority and user data.** Use the
   [backlog cancellation protocol](webhook-backlog-cancellation.md) only for an authorized fixed
   scope, with compatible readers throughout the fleet. Retain connected chats, settings,
   statistics, publications, original receipts/errors, claims and ambiguous actions. CANCELLED
   is abandonment, not success. Never use Redis FLUSH/obliterate, delete claims, expire unknown
   effects or fabricate completion to clear SQL ordering. Existing holds remain in force. Keep object and SQL cancellation readers aligned: message-family
   tombstones apply to created/edited content; exact semantic cancellation covers every type.
   Fresh removal observations and new menu clicks cannot inherit an unrelated message-family
   cancellation. Verify the final READY/start transition as well as early admission.
7. **Resume exactly.** An interrupted cancellation retains its UUID, cutoff, source/image and
   journal. Resume the identical request. A new operation requires the previous one COMPLETE and
   its exact completed journal archived privately by the controller. Preserve lossless BullMQ
   snapshot encoding (`BULLMQ_JOB_JSON_UTF8_BASE64_V1`); PostgreSQL JSONB cannot represent every
   JavaScript string. A missing Docker object is failed inventory proof, not evidence of ownership.

## Minimum regression coverage by change

These are existing executable regressions, not substitutes for required impact checks or exact-SHA
CI. Paths in the table are relative to `apps/api/src` except the explicit `infra/` path. Run the
rows affected by a change; do not rerun unrelated suites for a documentation-only edit.

| Change                                      | Required evidence                                                                                                                                                                  | Existing regression                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Notice authority/callback/handoff           | Own pre-dispatch rejection finishes without send/delete/coverage; 503, member 404, lease and attempted-send failures stay fenced                                                   | `moderation/required-subscription-notice-recovery.spec.ts`                                                                   |
| Any change to that notice outcome           | Real persisted source 404 finishes, source 503 stays fenced, evidence survives, next same-chat event progresses, handler never replays                                             | `webhook/webhook-multibot-moderation-guards-fullpath.spec.ts`                                                                |
| Post-notice membership outage               | Durable DELETE handoff survives queue failure; next same-chat receipt finishes; resumed deletion checks membership/policy and never repeats the notice or handler                  | `moderation/moderation.service.required-subscription.spec.ts`, `webhook/webhook-multibot-moderation-guards-fullpath.spec.ts` |
| Outbox writes, ordering or retention        | One SQL statement per atomic write, one CAS winner, no-op JSON does not rewrite a tuple, no started-engine replay; bounded retained-history work                                   | `webhook/webhook-outbox-postgres.spec.ts`                                                                                    |
| Polling, admission or prior-execution proof | Slow/blocked hot chat does not starve quiet chats; selection refills slots; dormant observations do not suppress valid execution; correlated probes stay indexed                   | `webhook/webhook-fleet-admission-postgres.spec.ts`                                                                           |
| Preparation capacity/reservations           | Per-bot/class fairness, lifecycle/interactive reservations, rejection without an in-memory waiting backlog and actual shutdown drain                                               | `webhook/webhook-preparation-admission.spec.ts`                                                                              |
| Bulk cancellation selection/snapshots       | Terminal FAILED history and tied timestamps remain bounded; Unicode snapshots survive; interruption resumes; uncertainty and publications survive; fresh same-chat work progresses | `webhook/webhook-backlog-cancellation-postgres.spec.ts`                                                                      |
| Cancellation controller/journal             | Interrupted identity is immutable and a completed journal is archived before a new request                                                                                         | `infra/scripts/backlog-cancellation.test.mjs`                                                                                |

For notice/handoff changes, run **both** the focused unit suite and the full-path native suite;
name-matching only `required-subscription` misses the integration expectation that exposed this
incident. Use Node 24 and the public wrappers, sequentially:

```bash
npm test --workspace @maxim/api -- 'required-subscription|moderation-execution-guard-callbacks'
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-multibot-moderation-guards-fullpath
```

For selection/admission or cancellation changes, choose the corresponding command:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- 'webhook-outbox-postgres|webhook-fleet-admission-postgres|webhook-preparation-admission'
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-backlog-cancellation-postgres
node --test infra/scripts/backlog-cancellation.test.mjs
```

The PostgreSQL Races CI lane already includes the native suites above. Report actual passed/skipped
counts and store availability; a mock-only pass is not native-store coverage. Never delete or weaken
a failing fence assertion to obtain green CI. An intentional outcome correction must retain the
negative cases, effects evidence and following-event/no-replay checks.

## Fast incident response and acceptance

- Capture one bounded baseline with exact UTC interval and runtime source/image, then compare ingress,
  SQL selection, preparation, ordering/retry waits and actual action outcomes using the
  [incident playbook](../../incident-playbook.md). A saved error, busy preparation pool or raw oldest
  age alone does not identify a cause. Diagnose changed failure families after a fix separately.
- Correct the reproduced cause and preserve independent capacity. Size concurrency from useful
  throughput and database pressure, not slot saturation alone. Repeated per-chat cold stops are not
  an efficient fleet reset; when abandonment is authorized, use the compatible bounded bulk protocol.
- After one rollout readiness timeout, inspect the current exact fleet, fence and queue trend.
  Do not repeat an unchanged deployment, repeatedly move a cancellation cutoff, lengthen readiness
  just to pass, or kill an unverified process. Preserve the typed journal and shared deploy lock.
- Normal delivery requires green exact-SHA Required and CodeQL through the guarded wrapper. An
  incident's recorded emergency exception is not authorization to bypass the connector next time.
  If the exact fleet already converged, use the guarded recovery finalizer after strict smokes;
  do not recreate healthy roles to apply a test-only fix or merely repair manifest bookkeeping.
- Measure only **closed** receipt-created cohorts: `from < until <= observedAt`. Include every
  status, pending/failed counts and ages, cap/truncation, missing samples and invalid-clock counts.
  Label completed-only percentiles as such; report PROCESSED separately from DUPLICATE/CANCELLED.
  An empty or future window is not success. Measure remote actions separately from receipt settlement.
- `COMPLETE`, HTTP 200 and container uptime are separate from recovery. Require exact images,
  released queues, healthy dependencies, fresh event progress and action outcomes. The prolonged-
  backlog acceptance remains at least 15 continuous minutes with lag below 10 seconds under the
  [recovery runbook](bot-reliability-recovery.md#capacity-and-acceptance). Short healthy samples
  justify a sampled improvement report, not full acceptance or a guarantee for every bot/product.
