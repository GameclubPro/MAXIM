# Bot Reliability Recovery

## Diagnose Before Retrying

For webhook selection, execution handoff or backlog changes, first use the
[latency prevention checklist and regression matrix](webhook-latency-prevention.md).
Its [incident review](../incidents/2026-10-10-webhook-latency-recovery.md) separates reproduced
causes from recovery-command success and records the limits of short healthy samples.

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

After a preparation failure is committed, `api-enqueue` records
`Recorded webhook preparation failure` with an allowlisted error code, bounded HTTP
status, attempt/delay and a known service's numeric location. It never includes the
event, chat, participant, error message, payload or stack. This preserves evidence
after a successful retry clears the receipt's error. Lost-CAS observations do not
produce a committed-failure log, and diagnostic extraction cannot alter retry state.

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

`publisher-start` v2/v3 jobs execute only in `api-publisher`. They use the existing
immediate SEND_MESSAGE path with a stable job-derived, bot-scoped idempotency key
and PostgreSQL `max_action_ledger` dispatch fence. The Redis claim and job marker
remain a second guard. They are never the sole proof after dispatch.

- A confirmed result is recovered from the durable receipt without another MAX send.
- An unresolved attempted send stays fenced for manual review, including after a
  Redis restore. A PostgreSQL failure before dispatch prevents sending.
- New producers persist a `publisher_start_intents` row before Redis enqueue or
  webhook acknowledgement. Recovery scans at most 100 due PENDING rows every 30 seconds
  under a ten-second sweep budget, retaining the original job ID, bot and 24-hour deadline.
  A failed Redis job can retry only while the exact durable intent is still PENDING.
- Immediately before HTTP, v3 changes PENDING to ATTEMPTED by exact identity CAS.
  SENT/UNKNOWN/ATTEMPTED are never recovery producers. A crash after that CAS and before
  HTTP can leave an unsent greeting unresolved; availability never overrides the fence.
- A failure before the send guard can retry under the existing bounded job policy.
- v1 jobs are rejected without a send: an old snapshot cannot prove whether their
  Redis-only attempt already happened. Do not upgrade retained v1 job data or clear
  its dispatch marker. A new user-initiated start creates a separate request.
- The shared API release fence prevents new producers and old consumers from
  running together. Older workers reject v3; rolling back cannot preserve greeting
  availability without a compatible worker. Prefer a forward fix or an image that
  retains this protocol. Do not restore v1 work into a legacy worker.

No historical receipt or v1/v2 job is converted to a new durable intent. Recovery
stays off while Publisher dispatch is disabled and expires intents for a replaced bot.
Keep the new additive table on rollback; a v2-only image cannot provide v3 recovery.
PostgreSQL point-in-time rollback still requires the external dispatch fence below.

## Redis State Inventory

| State                                     | Authority                                    | Recovery Boundary                                                         |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Accepted moderation webhook               | PostgreSQL receipt/outbox                    | Existing canonical execution and ordering fences                          |
| Attempted MAX send                        | PostgreSQL action ledger where integrated    | Confirmed receipt or explicit ambiguity; never blind resend               |
| Publisher greeting v2/v3 attempt          | PostgreSQL SEND_MESSAGE ledger and v3 intent | Exact bot/job key; Redis-only evidence is insufficient                    |
| Never-dispatched v3 greeting              | PostgreSQL PENDING intent                    | Same ID only, original bot, 24-hour deadline, no durable attempt          |
| Never-dispatched legacy greeting          | Redis job plus original webhook history      | No reconstruction from historical receipts                                |
| Night-mode schedules                      | Durable registry/ledger and current settings | Rebuild future work using the night-mode runbook; no historical catch-up  |
| Locks, counters, caches, private sessions | Redis with feature-specific semantics        | Do not treat restored grants, locks or session state as current authority |

Before changing Redis persistence, test RDB/AOF restore and crash points on an
isolated environment. Measure fsync/rewrite I/O, memory, disk headroom and recovery
time. AOF everysec reduces the persistence window but does not make remote sends
exactly-once. Keep production Redis unchanged until an explicit maintenance plan
has a verified backup, restore test, capacity budget and worker-fencing sequence.

## Restore Matrix

Dispatch must remain fenced outside the restored databases until reconciliation
finishes. The recovery objective for confirmed remote effects is zero duplicate
mutations, not zero missing greetings. Data RPO is the measured backup/WAL boundary;
do not advertise zero RPO for remote effects after a database rollback. Set a
maintenance RTO before the drill; no production RTO is validated by unit tests.

| State                           | PostgreSQL Older Than Redis                                                        | Redis Older Than PostgreSQL / Lost                                   | Release Condition                                                |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Webhook receipt/outbox          | Quarantine the interval newer than the restored point                              | Re-enqueue canonical durable receipts under existing ordering fences | Identity and execution claim match; no uncertain external effect |
| MAX ledger/receipt              | Missing row is not proof of no send; retain external fence                         | SQL receipt is authoritative; stale job cannot reset it              | Confirmed receipt or unresolved quarantine                       |
| Publication occurrence/delivery | Quarantine affected intervals, including jobs whose row disappeared                | SQL revisions and receipt-first recovery; preserve AMBIGUOUS         | Exact bot/message and unchanged content/occurrence identity      |
| Greeting                        | Do not rebuild PENDING from an older snapshot until uncertain interval is reviewed | Fresh v3 PENDING recovers; attempted states never originate sends    | Same identity, bot, unexpired deadline, no durable attempt       |
| Night mode                      | No historical catch-up from restored settings                                      | Rebuild future boundaries from durable registry                      | Current lifecycle/session and original intent                    |
| Notifications                   | Missing recipient receipt remains uncertain                                        | Confirmed recipient state survives; UNKNOWN stays fenced             | Exact recipient/intent, no unknown attempt                       |
| Sessions/access caches          | Discard restored grants and sessions before reopening access                       | Re-authenticate, re-probe access under SQL lifecycle epoch           | Current bot state, actor and entity evidence                     |
| Leases/backoff/cursors          | Never use restored leases as new authority                                         | Rebuild leases via feature CAS; cursors may expire safely            | Current revision/owner; foreign cursors rejected                 |

Exercise each column on disposable state, including repeated restore and a crash
between intent commit, Redis enqueue, durable attempt, HTTP acceptance and receipt.
Record restored timestamps, fence ownership, elapsed time and unresolved counts.
The v3 greeting integration suite covers Redis job loss and competing attempt CAS;
it does not establish correctness of a full production PostgreSQL restore.

## Evidence Retention

| Data                                   | Cleanup Owner / Current Boundary                                          | Deletion Condition                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MAX action ledger and send receipts    | Domain recovery; no generic TTL introduced                                | Keep uncertainty and live idempotency references; never purge to free deployment space                           |
| Greeting v3 intents                    | Recovery expires pending work at 24 hours; compact terminal rows retained | No cleanup until a restore/replay horizon is approved                                                            |
| Greeting Redis jobs/claims             | Two-day retention; original job identity                                  | SQL intent/ledger remain authoritative after Redis expires                                                       |
| Publication occurrences/content/assets | Authoring and domain lifecycle                                            | Preserve all pending, ambiguous and post-action references; only proven unreachable media is a cleanup candidate |
| Upload/import sessions                 | Existing deadline/recovery services                                       | Session terminal, no retained content/asset reference                                                            |
| Comment notifications                  | Existing bounded delivery retention                                       | Retain UNKNOWN evidence and recipient dedupe through allowed recovery age                                        |
| Refresh operations/catalog cursors     | Redis, one hour / fifteen minutes                                         | Expiry becomes unavailable/invalid, never success or permission grant                                            |

No new bulk cleaner or storage quota is enabled by this release. Before choosing
an author storage quota, measure database/WAL/backup growth on bounded inventories,
define warning and rejection UX, and preserve existing saved publications. Audience
size has no product ceiling; technical request/page sizes are independent of storage.

## Publication Review And Post Actions

Use the production-safe aggregate preview first:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-publications --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-publications
```

The application review CLI is read-only and returns explicit unresolved cases and
a checkpoint. Run against an isolated copy, or through a separately reviewed operator
path with exact scope; it is not a replacement for the fixed production audit catalog:

```bash
npm run publication:audit-backlog --workspace @maxim/api -- --status AMBIGUOUS --since 2026-09-01T00:00:00Z --until 2026-09-28T00:00:00Z --limit 20
```

`--verify-exact` reads recorded remote IDs with each delivery's original bot. No ID,
lookup error, absent message or expired route remains unresolved; none authorizes
resend. Review overflow deliveries through the existing occurrence details endpoint.
Apply a human-confirmed outcome through the existing author-scoped resolution endpoint:
the delivery CAS, mutation receipt and `PUBLICATION_DELIVERY_RESOLVED` audit event commit
atomically. The audit contains identifiers and decision metadata, never message content.

Scheduled ONCE/SLOTS older than the existing five-minute dispatch grace require
explicit author retry or schedule edit. Expired recurrence slots are skipped; NOW
keeps interactive recovery. Before rollout, preview old SCHEDULED rows and their
mode/time range; this is a behavior change and does not authorize a bulk send.

Pending pin checks current author access, enabled policy, publication lifecycle,
exact bot and fresh binding at the final HTTP boundary. Pause/cancel, revoked access
or re-added bot defers pin without consuming a MAX attempt. Previously committed
timed deletion retains its original obligation; cancellation uses the existing explicit
delete action. Receipt repair makes no new remote mutation. Unknown pin stays AMBIGUOUS.

Catalog pages use live `chat_id ASC` keyset order, with actor/bot/filter-bound shared
cursors. Inserts after the cursor may appear; inserts before it appear after refresh.
Revocation is rechecked on every hydration. Summary may lag up to fifteen seconds.

## Capacity And Acceptance

Retain the shared API 10 GiB and static 6 GiB clean-build floors. Required online
multibot preparation separately checks and supervises a 10 GiB filesystem reserve;
its modeled peak estimates are advisory. Exact-SHA CI
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
