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
