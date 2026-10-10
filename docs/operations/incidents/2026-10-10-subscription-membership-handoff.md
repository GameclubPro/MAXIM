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
