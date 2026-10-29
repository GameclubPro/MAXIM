# Retired Major Message Retention

The independent «Ластик» service is the sole executor of age-based message deletion,
including historical cleanup and 24/48/168-hour settings. Its rollout, protection,
capacity and acceptance gates follow [the Eraser runbook](eraser-rollout.md).

Major's old capture and DELETE paths are removed. `MESSAGE_RETENTION_MODE` and
`MESSAGE_RETENTION_CANARY_CHAT_IDS` remain accepted compatibility settings; no value
can restart the retired executor. Disabling Eraser never returns execution to Major.
Ordinary moderation and explicit manual moderation retain their separate behavior.

## Retained Compatibility Work

The shared API keeps the `api-message-retention` role and `message-retention` queue
for bounded database maintenance of existing records. PostgreSQL retains policies,
candidates, delete intents, quota accounting and ownership-transfer evidence.
These records are not new cleanup jobs.

The scheduler admits at most 100 fixed BullMQ slots with global concurrency one.
Visits settle saved receipts and cancel candidates from disabled or ended
activations; transferred generations retire through their bounded indexed pass.
Maintenance performs no MAX reads, creates no delete intent and dispatches no DELETE.
Startup does not synthesize an immediate cleanup pass. Completed compatible records
are purged after their retention period in bounded ordered batches; unresolved effects
remain retained.

Saved successful DELETE evidence and authenticated exact `message_removed` receipts
can settle legacy counters and journals. Cancellation releases active quota only once.
A dispatch marker without positive completion evidence remains unresolved: never
repeat DELETE, infer success from absence reads, clear a queue or erase effect evidence.
Normal moderation must not adopt a retention-owned intent to bypass that boundary.

## Settings And Diagnostics

The public `/v1/chats/:chatId/message-retention` API sends all changes to Eraser.
It preserves the requested 24/48/168-hour interval, revision and operation identity.
An absent or disabled Eraser bridge returns an availability error without writing
legacy policies. There is no local settings fallback, including when disabling cleanup.

Read ownership from persisted `eraser_chat_bindings`, independently of execution flags.
Eraser-owned diagnostics remain visible when execution is disabled. Unowned legacy
policies and journals remain available as read-only compatibility diagnostics in the
closed Safety Desk. Legacy preview pages are bounded and paginated; retry is always
unavailable. The ordinary deletion retry endpoint also refuses retention-owned intents.
Eraser's guarded retry path remains a separate contract.

## Validation And Release

Run the focused runtime, intent, settings and Safety Desk tests, plus
`test:retention-storage` with explicit disposable localhost PostgreSQL and Redis for
receipt settlement, quota release, transfer retirement and BullMQ recovery. The public
wrapper owns code generation; no live MAX calls are needed. The old Major capacity
command and admission sampler are retired; use the independent Eraser benchmark and
its measured sustainable throughput for future capacity work.

Use the normal exact-SHA CI and shared-image deploy workflow for all API roles. Both
rollback paths require the retired-executor reader floor as well as the existing
receipt, ownership and protection compatibility checks. Preserve all current stores.
An older image that can resume capture, create retention intents or dispatch age-based
DELETE is not an eligible rollback target, regardless of its environment flags.

## Index Migration Recovery

A lock timeout in `20261002020100_index_retention_reconciliation` can
leave a mixture of missing, valid and invalid indexes. Preserve both immutable
migrations and the interrupted release journal. Use the fixed recovery command
from a clean, synchronized checkout with green exact-SHA CI:

```sh
./infra/scripts/vps-connect.sh recover-message-retention-migration
./infra/scripts/vps-connect.sh recover-message-retention-migration --apply
./infra/scripts/vps-connect.sh recover-message-retention-migration
```

Review preview before apply. The helper verifies the preceding additive receipt,
column definitions, migration checksum and all three exact index definitions,
including the reconciliation predicate. Under the shared deploy lock it creates
missing indexes or reindexes invalid ones concurrently, then verifies their
readiness/validity before resolving the fixed receipt as applied. Unexpected DDL,
unrelated failed receipts or concurrent-index artifacts abort. Table size,
statement and total time are bounded; no candidate rows are changed.

Keep `MESSAGE_RETENTION_MODE=off` and the cohort empty. Recovery does not alter
queues or finalize a release. After preview confirms all three indexes healthy,
the receipt applied and no other failures, resume the ordinary release workflow:

```sh
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1 \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

Use adoption only for the reviewed interrupted transition, never persist it in
the production environment. Normal deploy re-proves the queue fence, recreates
the selected components, runs strict smokes, resumes queues and records the new
manifest. The no-recreate release finalizer cannot recover an old runtime.

## Stop And Recovery

Stop independent cleanup through Eraser's reviewed settings or deployment controls.
Major remains permanently unable to execute age-based deletion. Preserve ownership,
receipts, unresolved effects and database maintenance during recovery; never remove
Redis/PostgreSQL state to make backlog or uncertainty disappear.
