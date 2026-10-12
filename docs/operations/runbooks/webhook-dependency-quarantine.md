# Webhook dependency quarantine

An unknown started handler retains its original FAILED receipt and error evidence.
Classification accepts the existing pending timeout marker, or an exact enforced canonical
claim with a business start and no completion; generic FAILED text alone is insufficient.
Its ordered message successors can enter `QUARANTINED` only while they are positively
unstarted. Their immutable `(receipt_id, blocker_id)` journal records chat, original status,
deadline and time. A second blocker creates another journal entry. No quarantine operation
changes the uncertain original, claims or MAX action evidence.

When a different bot's earlier copy is the physical order head, bounded indexed discovery
retains that receipt as `anchor_id` and the real failing owner as `blocker_id`. Pristine
never-activated copies may be parked only with the exact enforced shared owner and no
independent/legacy claims. An activated or independently claimed copy retains its existing
fences. Resolving the owner cannot replay its copies; normal canonical settlement deduplicates
them. Retention also pins the order anchor.

The scheduler handles at most 16 candidates per affected chat task. A separate single owned
reconciliation task reads at most 16 due rows per pass, using the persisted due index and a
60-second recheck interval. It never dispatches MAX actions. Shutdown drains that task before
closing Prisma. An item failure advances only its scheduling hint and leaves its evidence
unchanged, allowing other items to proceed.

Parking stops admitting further transactions after its 500 ms dispatch budget, without
cancelling an in-flight transaction. Mirror discovery rotates at most 64 exact heads and has
a 250 ms pool admission / 500 ms SQL budget. Failed discovery retains the existing fences.

## State and recovery

| Journal state | Receipt scheduling                 | Meaning                                                                                                               |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| WAITING       | QUARANTINED                        | Exact predecessor has not supplied completion proof                                                                   |
| RELEASED      | RECEIVED, then ordinary processing | Exact clean PROCESSED predecessor and its enforced COMPLETED claim proved completion; original deadline remains valid |
| EXPIRED       | QUARANTINED                        | Unstarted dependent work exceeded its original deadline; no business retry                                            |

`RELEASED` is not proof that a successor executed. It must still pass normal preparation,
ordering, ownership, current policy and business-start checks. The final transition checks
the saved deadline again; it cannot renew the processing window. A parked stale BullMQ job
returns without business execution. A started, completed, leased, ambiguous or independently
claimed successor does not qualify for parking.

The scope is deliberately the existing ordered chat dependency. Other chats and nonordered
events retain independent capacity; administrative HTTP/mini app operations remain available.
Ordered group commands in the affected chat remain dependent. Releasing them independently
requires a separately proven command-only authority path; do not skip the original fence.

Neither timeout expiry, FAILED/terminal text, an absent root nor an unmatched successful
receipt authorizes release. There is no unconditional retry button or automatic cancellation.
Existing explicit cancellation/recovery procedures retain their own authority and scope;
this feature does not widen a previously approved cutoff.

## Visibility and release gates

Local readiness includes `checks.queueLag.quarantinedCountLowerBound`,
`quarantineSampleLimitReached` and `oldestQuarantinedAgeSec`. The covered query reads at most
65 retained receipt heads; 65 means **at least** 65. Age is receipt age. These fields describe
retained dependent work separately from active RECEIVED/QUEUED lag; a healthy fleet can have
an unresolved quarantine. They must not be represented as successful moderation.
`postgres-audit webhook-cohort` includes QUARANTINED as its eighth status. The closed cohort
report does not prove remote effects or resolve historical quarantine.

Prepare a green exact-SHA compatibility image with writes disabled and retain it on the
host before activation. A healthy installation can deploy this reader release first, then
activate in a subsequent release. For an already degraded installation, use one ordinary
fenced activation deployment: the existing mandatory controller pauses the webhook queues,
stops and verifies enqueue and every moderation role, replaces all non-webhook readers,
replaces moderation, then starts enqueue last. No old worker may survive that fence. Verify
all exact images and both native auxiliaries before releasing queues; strict readiness and
release finalization still happen after activation. Never use an unfenced rolling update or
bypass readiness to record a release. Both rollback wrappers enforce quarantine readers;
use the retained compatible manifest, or `rollback-runtime` to the green writer-disabled
compatibility SHA when that build was preloaded without a production manifest. A writer
downgrade retains parked evidence but does not promise to isolate new failures. The schema is additive, has no history backfill and creates indexes only on a new
empty table. Retention pins both dependent and predecessor evidence via indexed checks/FKs.

Required native regression:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- 'webhook-dependency-quarantine-postgres|webhook-outbox-postgres|webhook-fleet-admission-postgres|webhook-operational-lag-postgres|webhook-multibot-fullpath|message-duplicate-history.redis-integration'
```

The quarantine suite is mandatory in PostgreSQL Races/Required CI. It covers final independent
execution through real BullMQ and canonical receipts, replay denial, multibot copies, late
success, expiry, restart, repeated incidents, persistence failure, concurrent lease/start,
and bounded due selection across retained history. The Redis suite retains the delayed reply
after commit regression. Run the other affected rows of
[webhook latency prevention](webhook-latency-prevention.md), then the normal impact checks.
After activation observe closed fresh cohorts and the existing continuous 15-minute acceptance
window; preserve failures and quarantine counts rather than declaring success from HTTP 200.
