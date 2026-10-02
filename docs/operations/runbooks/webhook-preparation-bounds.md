# Bounded webhook preparation

The public ingestion facade acknowledges only after storing a durable receipt. Ordinary ACKs
do not wait for preparation. Duplicate membership repair retains its existing ACK deadline and
requests redelivery if it cannot complete. Preparation runs from the existing webhook outbox;
its capacity deferrals preserve the receipt and do not exhaust enqueue attempts.

`WebhookPreparationAdmission` permits `max(1, min(8, floor(poolMax / 2)))` active preparations
per process, using the same `PRISMA_PG_POOL_MAX`/legacy pool reader as Prisma (default pool 10).
There is no pending RAM queue. Each bot/work-class pair gets at most half those slots, rounded
down with a floor of one. Ordinary traffic, explicit Start and lifecycle transitions have separate
classes, so one slow Start does not occupy that bot's ordinary allowance. Only one Start runs at
a time per process. A lifecycle event deferred by capacity reserves the next available slot for
five seconds; non-lifecycle work can continue in other slots. These are concurrency budgets,
not a replacement for existing per-token MAX rate limits.

Before an event becomes prepared, the service waits for membership SQL/cache work, binding
reconciliation, idempotent SQL read models, bootstrap cache completion, any required owner
recheck, roster queue acknowledgement and explicit Start handling. Read-model/cache invalidation
or roster handoff failures use the existing non-exhausting preparation deferral. The optional
recent-bootstrap cache retains its existing best-effort error behavior; it is not access proof.
An unknown result from a required owner probe also defers preparation; it is never treated as
a completed recheck. Existing membership-denial coordination and its separate bounds remain intact.

No unrelated events or grant/revoke transitions are coalesced. The same stored receipt and
semantic claim recover after interruption. Preparation marks READY only after required work
settles. A winning mirrored receipt remains canonical; duplicates do not repeat its effects.
Start retains fresh bot/user checks and the existing exact-update MAX ledger key. An ambiguous
send is never assigned a new key or automatically reset. Passive events send no confirmation.

The service participates in `RuntimeWorkerOwner` discovery. Admission stops synchronously;
the normal runtime grace period drains admitted preparation before Nest closes SQL/Redis.
Forced shutdown leaves unprepared receipts for recovery. Do not extend the hard shutdown deadline
or launch detached work after stopping admission.

`webhook_preparation_admission_v1` emits fixed per-class admitted/deferred counts, duration
histograms, peak/current in-flight, zero RAM pending, capacity and active-scope count. It emits
no bot/chat/user identifiers. Duration includes bounded SQL/MAX waits, not receipt age; use outbox
oldest-eligible progress and existing receipt/queue metrics for end-to-end latency. Empty windows
and a healthy HTTP endpoint do not prove full coverage or successful permissions.

Validate with public locked API checks, the webhook/ingestion/admission/shutdown suites and
`test:postgres-races`. PostgreSQL tests retain a pending claim after injected failures at follow-up
boundaries, recover the same claim after service restart, verify shutdown draining, and suppress
mirrored preparation. Burst tests cover 1,000 rejected calls without retained pending promises,
independent bots/classes and the lifecycle reserve. Existing MAX ledger/handshake tests remain
mandatory; no live diagnostic messages are used.

Deploy with exact-SHA CI through the guarded shared API rollout. During acceptance compare
preparation duration, capacity deferrals, oldest eligible receipt progress, pool errors, MAX errors
and moderation lag across comparable traffic. Persistent deferrals with absent progress require
investigation; raising worker or SQL concurrency is not the default repair. This package has no
schema migration. Rollback retains receipts, claims and send ledger identities; never clear them.
