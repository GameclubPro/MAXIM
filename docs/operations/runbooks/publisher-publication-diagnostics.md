# Publisher Publication Diagnostics

Use the fixed read-only catalog to distinguish missing actor access, missing bot/catalog
evidence, disabled publication policy and attempted/ambiguous deliveries:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-publications --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-publications
```

After synchronizing this catalog, preview and apply the reviewed audit-role provision
step before using it. It grants 43 exact publication/access metadata columns and expands
the existing Publisher binding/comment group from 14 to 16 columns. Identifiers are
used only for exact joins; report output contains fixed categories and aggregate counts,
not identifiers, publication text, media, URLs, token values or raw permission snapshots.
The role has no business-data write privilege and retains the existing one-connection,
read-only, statement, lock, wall-clock, memory and temporary-file limits.

The report samples the oldest 32 due PUBLIK_V1 occurrences for each of SCHEDULED,
IN_PROGRESS, AMBIGUOUS and FAILED. Each selected occurrence contributes at most eight
target slots and eight delivery rows. One extra row detects truncation at each boundary.
Required indexes are attested before the query; `--explain` never executes it.

Counts describe sampled occurrence/target/delivery slots, not unique users or entities.
Repeated schedules can therefore contribute the same recipient more than once. Saturated
or truncated samples are not a complete inventory. `metadata_ready` does not prove MAX
write permission: raw permission data is deliberately outside this diagnostic.

Interpret all blockers together with lifecycle and schedule status. A disabled policy or
fresh denied actor must never be silently enabled or granted access. A missing/expired
cache may nominate an exact Publisher-owned verification, not authorize a send. A remote
message ID or an attempted/AMBIGUOUS delivery must retain its receipt and dispatch fence.
No report outcome authorizes bulk retry or recreating a failed publication as a new send.

This command makes no MAX calls, runs no publication workers and changes no queue or
application state. Use normal product authentication for any separately reviewed action.

## Publication Delay Investigation, 2026-09-27

A bounded post-release log sample contained 34 deadline delivery claims with lateness
between 32.7 seconds and 74.4 minutes (median 18.3 minutes). These include historical
catch-up and measure claim time, not MAX-confirmed delivery or a new-publication SLO.
The action role paused preparation during an automatic webhook backlog of roughly
46-48 minutes and also reported host-load pressure. The capped database audit still
found fresh actor-access denials. Those denials must not be overridden to reduce lag.

The latency fixes retain the existing per-bot budgets, two-connection Publisher pool,
receipt fences, post-send stability window, and serialized background coordinator:

- Only publication preparation opts into a bounded slow path for automatic webhook
  backlog. Manual, MAX, mixed/unknown emergency modes and hard CPU/I/O pressure still
  pause it. Slow preparation uses two rows per pass; normal preparation retains its
  existing limits. Actual sending remains Publisher-owned.
- Preparation selects unblocked rows first and reserves a small recovery share for
  previously blocked work. Recovery rotates by last blocked check, with at most two
  reserved slots and no increase to the total batch. Two concurrent indexes support
  the new ordered selections; the migration changes no application data.
- Targeted wakes yield after four passes or a five-second soft budget; global sweeps
  also yield between envelopes. Each Publisher send quantum claims at most four
  recipients. The budget never cancels an in-flight MAX call, so a slow individual
  send can exceed it. Remaining deliveries retain their durable state.
- NOW and scheduled work have independent pending-work timers, with a 250ms overdue
  rearm and sequential database reads. A completed
  NOW wake no longer waits for unrelated scheduled work in the background coordinator.
  The 15-second safety poll remains; pauses and failed sweeps do not spin the timer.
- Delivery verification becomes selectable only after its initial delay and persisted
  next-check time. Future verification rows cannot displace currently due verification.

Regression coverage includes a real disposable PostgreSQL fixture with 3,000 old
blocked occurrences, fresh-work priority, rotating recovery, the actual generated
query plans, future verification exclusion, and pending NOW selection. Timer tests
cover nonoverlapping continuation, pause, shutdown, and strict wake failure propagation.
The PostgreSQL suite is part of `test:postgres-races` and requires a local `race_test`
database; it never sends messages to MAX.

After rollout, use the bounded catalog, Publisher dispatch health and existing
`Publik publication deadline delivery claimed` logs. Compare newly due work separately
from catch-up and denied targets. A healthy release alone does not prove delivery of
all historical posts. Investigate a concrete occurrence through authenticated product
access when a user reports a remaining delay; never turn that investigation into a
bulk retry of attempted, failed-with-receipt, or ambiguous deliveries.

Post-rollout diagnostics also identified a separate global governor input: moderation
pre-dispatch lookups counted target-local HTTP 404 responses as user-facing MAX failures.
One sampled 60-second health window contained 26 failures in 1,155 calls, no critical
failures, and zero webhook lag; the bounded failure logs reported `moderation_delete`,
HTTP 404 and `not.found`. This can keep publication preparation paused despite an empty
webhook queue. Moderation pre-dispatch reads now use the same existing 403/404 metric
exclusions as the delete mutation. Errors still propagate and preserve fail-closed
authorization/absence handling; 429, server and network failures remain health signals.

## Priority Index Migration Recovery

If `20260927160000_index_publication_materialization_priority` stops with a lock
timeout, preserve its immutable SQL and the deploy transition journal. Synchronize
the reviewed, green exact-SHA checkout before using the fixed recovery command:

```bash
./infra/scripts/vps-connect.sh recover-publication-priority-migration
./infra/scripts/vps-connect.sh recover-publication-priority-migration --apply
```

Review the preview before applying. The command validates the checksum and one active
zero-step lock-timeout record, rejects other failed migrations, and checks exact index
parents, keys, sort definitions, methods, predicates and validity. Metadata is capped
at 8 MiB and logs at 64 KiB; the occurrence table must be at most 512 MiB. Unknown
definitions, partitioned parents and concurrent-repair leftovers abort recovery.

Apply holds the deploy lock, requires healthy ingress/admin readiness and normal system
mode, creates absent indexes concurrently or reindexes exact invalid indexes concurrently,
and rechecks each result. Each DDL operation has a 30-second lock timeout, 120-second
statement timeout, zero parallel workers and bounded memory/temp usage. The wrapper has
a 420-second wall deadline and cleans only its own labeled container/backend. Only two
verified valid indexes permit `migrate resolve --applied`; the receipt is checked again.
No application rows, queues or release manifests are changed. A failed step leaves the
migration unresolved; inspect a new preview before considering another apply.

Continue through normal scoped API deployment afterward. An interrupted release journal
requires caller-only `MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1`; the normal deploy must
re-prove the queue fence and exact image inventory before recording the new release.
