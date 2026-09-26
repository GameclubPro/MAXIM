# Bot Reliability Recovery

## Diagnose Before Retrying

Use the routine bounded commands:

```bash
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh postgres-audit queue
./infra/scripts/vps-connect.sh postgres-audit activity
./infra/scripts/vps-connect.sh monitor-readonly 180 60
```

`health` stops on the first non-2xx endpoint. The monitor additionally preserves
sanitized readiness diagnostics from both API roles. Empty cached bot details
are printed as `unknown`, not an authoritative zero-bot inventory.

The queue report distinguishes retained FAILED history from RECEIVED/QUEUED work.
For the oldest RECEIVED event it exposes an exact indexed predecessor's age,
enqueue attempts, fixed error category, remaining retry delay and overdue duration.
`null` predecessor metadata means this lookup found no blocking predecessor; it
does not prove that every chat is unblocked. Categories classify stored error
prefixes, not the root cause. `error_family` narrows known constraint, lease, transport
and validation failures without returning their text. `error_truncated` signals
insufficient retained detail; `webhook_service_line` is only a numeric location in
the known compiled service, never a stack trace. Resolve it against the exact
running API image, not a newer checkout. No payload, error text or event identity
is exposed.

Compare repeated samples. A growing oldest age with small pending counts can be
an ordering fence, not a throughput shortage. Inspect the predecessor's retry
progress before considering resource changes. Do not force normal mode, skip
ordered work, mark receipts processed or purge queues to make readiness green.

Further database diagnostics must extend the fixed catalog with indexed, bounded,
privacy-safe reads and tests. Never substitute raw production SQL. An exact
recovery requires current execution-claim and action-ledger evidence; absence of
a remote message ID is not proof that a send did not happen.

## SLO Interpretation

Webhook backlog age covers all RECEIVED and QUEUED events, independent of the
configured SLO window. A RECEIVED event that was enqueued previously still counts
as pending. The service uses two exact-status oldest-row reads against the
`(status, created_at)` index, matching the readiness backlog definition.

Receipt counts and processing/enqueue latency samples still describe the recent
receipt-created cohort. They are not a completion-time cohort. Old work completed
now may be outside that latency sample even though its pending age was visible.
Moving those distributions to completion time requires reviewed indexes and
explicit consumer semantics; do not replace the predicates with unindexed scans.

## Publisher Greeting Protocol

`publisher-start` v2 jobs execute only in `api-publisher`. They use the existing
immediate SEND_MESSAGE path with a stable job-derived, bot-scoped idempotency key
and PostgreSQL `max_action_ledger` dispatch fence. The Redis claim and job marker
remain a second guard. They are never the sole proof after dispatch.

- A confirmed result is recovered from the durable receipt without another MAX send.
- An unresolved attempted send stays fenced for manual review, including after a
  Redis restore. A PostgreSQL failure before dispatch prevents sending.
- A failure before the send guard can retry under the existing bounded job policy.
- v1 jobs are rejected without a send: an old snapshot cannot prove whether their
  Redis-only attempt already happened. Do not upgrade retained v1 job data or clear
  its dispatch marker. A new user-initiated start creates a separate request.
- The shared API release fence prevents new producers and old consumers from
  running together. Older workers reject v2; rolling back cannot preserve greeting
  availability without a compatible worker. Prefer a forward fix or an image that
  retains this protocol. Do not restore v1 work into a legacy worker.

This closes duplicate-dispatch risk for the v2 protocol, not all Redis durability
risks. Loss of a never-dispatched greeting job still needs a reviewed durable
recovery producer. Do not replay historical start receipts to compensate for it.

## Redis State Inventory

| State                                     | Authority                                    | Recovery Boundary                                                         |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Accepted moderation webhook               | PostgreSQL receipt/outbox                    | Existing canonical execution and ordering fences                          |
| Attempted MAX send                        | PostgreSQL action ledger where integrated    | Confirmed receipt or explicit ambiguity; never blind resend               |
| Publisher greeting v2 attempt             | PostgreSQL SEND_MESSAGE ledger               | Exact bot/job key; Redis-only evidence is insufficient                    |
| Never-dispatched greeting job             | Redis job plus original webhook history      | No general safe requeue claim; reviewed recovery required                 |
| Night-mode schedules                      | Durable registry/ledger and current settings | Rebuild future work using the night-mode runbook; no historical catch-up  |
| Locks, counters, caches, private sessions | Redis with feature-specific semantics        | Do not treat restored grants, locks or session state as current authority |

Before changing Redis persistence, test RDB/AOF restore and crash points on an
isolated environment. Measure fsync/rewrite I/O, memory, disk headroom and recovery
time. AOF everysec reduces the persistence window but does not make remote sends
exactly-once. Keep production Redis unchanged until an explicit maintenance plan
has a verified backup, restore test, capacity budget and worker-fencing sequence.

## Capacity And Acceptance

Retain the shared API 20 GiB and static 6 GiB clean-build floors. Exact-SHA CI
preload is an alternative build location, not a disk-capacity fix. Use only
manifest-aware reviewed reclaim or an approved expansion; no host-wide Docker GC.

After an application release, require exact-image convergence, strict smokes,
released deploy fence and a representative read-only observation window. Observe
at least 15 minutes with lag below 10 seconds to accept recovery of a prolonged
backlog. A short healthy sample, passing tests or a healthy webhook subscription
does not demonstrate full live workflow acceptance.

Live send/moderation checks use only the designated test entities while production
is healthy. Crash/restore and 2x/4x load checks require disposable state, never the
sole production primary.
