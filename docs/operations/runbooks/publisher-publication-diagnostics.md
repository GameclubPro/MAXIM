# Publisher Publication Diagnostics

Use the fixed read-only catalog to distinguish missing actor access, missing bot/catalog
evidence, disabled publication policy and attempted/ambiguous deliveries:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-publications --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-publications
```

After synchronizing this catalog, preview and apply the reviewed audit-role provision
step before using it. It grants 43 exact publication/access metadata columns; the
Publisher binding/comment group has 17 columns including census activation source. Identifiers are
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
or truncated samples are not a complete inventory. The report explicitly declares
`readiness_scope=metadata_only` and `capabilities_and_activation_checked=false`.
`metadata_ready` does not prove MAX write permission or completed activation: raw
permission data and the activation handshake are outside this diagnostic. Positive bot
proofs do not expire; old/null expiry alone is not a blocker. `bot_access_unconfirmed`
means a missing/future confirmation timestamp, and `route_quarantined` is separate.
Report schema v2 treats confirmed ADMIN/OWNER grants as durable, matching runtime
authorization. Older v1 reports can contain `actor_authority_stale` and
`actor_edge_expired`; these historical age labels are not current authorization failures.
The retained `edge_unexpired` field describes a stored timestamp, not effective authority.
`missed_window` identifies a missed scheduled window requiring an author decision; it is separate from `AMBIGUOUS` delivery results.

Interpret all blockers together with lifecycle and schedule status. A disabled policy or
fresh denied actor must never be silently enabled or granted access. Missing bot or actor
evidence may nominate an exact Publisher-owned verification, never authorize a send.
Historical age labels must not trigger a refresh or reset of a confirmed human grant.
Explicit bot denial requires administrator
reconnection; passive verification cannot bypass activation. A remote
message ID or an attempted/AMBIGUOUS delivery must retain its receipt and dispatch fence.
No report outcome authorizes bulk retry or recreating a failed publication as a new send.

This command makes no MAX calls, runs no publication workers and changes no queue or
application state. Use normal product authentication for any separately reviewed action.

For a fresh Publisher identity and webhook-target check, use the built standalone probe:

```bash
./infra/scripts/vps-connect.sh exec 'docker compose -f infra/docker-compose.yml exec -T api-publisher node apps/api/dist/apps/api/src/scripts/attest-publisher-identity.js'
```

Success prints `PUBLISHER_IDENTITY_ATTESTED`. The probe reads `/me` and `/subscriptions`
without starting the application, sending messages or changing subscriptions. It checks
the exact bot and webhook target; it does not verify update-type coverage or publication
delivery. Invoke the built file directly: the runtime image omits the repository-root
package manifest required by a root-level `npm run --workspace` invocation.

## Current scheduling and recovery

Deadline dispatch and imminent-publication preflight each have one coalesced coordinator
slot, independent of the serialized recovery slot. The existing MAX limiter, two refresh workers
and SQL send fences retain their quotas and ownership. Publication scheduling is owned by
`api-publisher`; `api-action` no longer scans these schedules. `publisher_background_budget_v1` reports a lane
whose wait or execution exceeds five seconds; this observation never cancels an effect.

Preflight considers the next ten minutes, with at most eight target nominations per
pass and sixteen queued preparation jobs. Two queued urgent jobs suspend speculative
admission. Saved snapshot audiences are materialized in full; a blocked recipient does
not prevent other recipients from preparing. A bounded page prepares each pending
context independently. Version zero is intent only; SQL forbids sending until the
untouched delivery wins the single transition to immutable version one. Every actual
send still rechecks actor, bot, content, policy and schedule authority.

New schedules persist an explicit late policy: by default recover for 24 hours and,
for recurring schedules, retain the latest due durable occurrence of the same revision.
The author may choose another deadline or all still-current repeats. Existing schedules
without this field retain their five-minute window. New occurrences snapshot `deliveryDeadlineAt`;
new NOW intent expires after 24 hours. New author retries persist a separate 24-hour
`retryExpiresAt`; old grants keep their five-minute authorization. Expiry fails only unsent claimable recipients and
the exact owned pre-HTTP claim; confirmed and uncertain effects retain their evidence.
No policy permits replay of an ambiguous send. Cancellation still consumes a slot in
new recurrence limits, and catch-up materialization is capped at 300 slots per pass.

Confirmed Publisher bot and human ADMIN/OWNER rights do not expire. SQL reads enforce
explicit revocation, exact bot, binding, policy and lifecycle before new effects.
Never clear existing access edges to activate this release. Bare 403/404 and partial
MAX responses are unknown; explicit chat/access denial or a valid complete roster
can revoke rights. There is no periodic all-chat permission scan.

Recipient `nextAttemptAt` persists across restarts. MAX Retry-After is a lower bound;
without it, external 429 backs off 30/60/120/240/300 seconds plus bounded positive jitter.
Local capacity and circuit hints retain their exact available time. External cooldown
is token-scoped in the existing atomic GCRA boundary. Publisher SEND yields immediately
on local rejection; other tokens and ready recipients retain their own progress.
A retry beyond intent expiry wakes the envelope for SQL expiry without an early SEND.

The existing Bull wake remains an acceleration hint. SQL occurrences/envelopes are the
durable queue; a lost post-commit wake is repaired by the 15-second Publisher poll.
No separate outbox or second executor is required. Polls coalesce and shutdown waits
for owned work. Automatic fleet MAX degradation permits only bounded SQL preparation;
manual pause, Publisher identity pause and host pressure remain authoritative.

`publication_delivery_v1` separates `max_acknowledgement_observed` from
`receipt_persisted`. The former is the observed wrapper-return time, not a MAX server
timestamp or verified visibility. Keep both clocks separate from claim delay and
post-action completion. Measure fresh due cohorts separately from historical failures,
denials and ambiguous receipts; a healthy queue or an empty sample cannot prove the
publication SLO. Retain release, observation interval, sample size and truncation.

The target-preparation migration replaces only the context constraint/trigger, with no
history rewrite or validation scan. Its new constraint checks all new writes. Both API
rollback paths require the current deadline/recipient-wait/durable-authority readers and Publisher scheduling wiring;
use reviewed current wrappers and a compatible forward correction if an older image
fails that source floor.

## Publication Delay Investigation, 2026-09-27

A bounded post-release log sample contained 34 deadline delivery claims with lateness
between 32.7 seconds and 74.4 minutes (median 18.3 minutes). These include historical
catch-up and measure claim time, not MAX-confirmed delivery or a new-publication SLO.
The action role paused preparation during an automatic webhook backlog of roughly
46-48 minutes and also reported host-load pressure. The capped database audit still
found fresh actor-access denials. Those denials must not be overridden to reduce lag.

This historical investigation retained the then-current per-bot budgets, two-connection
Publisher pool, receipt fences, stability window and serialized coordinator. The current
coordinator separation above supersedes only that serialization detail:

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
- A PENDING recipient with the exact `PUBLISHER_ACTOR_ACCESS_REQUIRED` marker becomes
  eligible for the pending-work timer only after its persisted 60-second retry delay.
  The worker still verifies current bot/actor/policy authority before claiming and sending.
  A refused recipient renews its delay; other blockers, route quarantine, ambiguous
  effects and fresh in-flight siblings remain excluded. This prevents a recovered large
  audience from draining only four recipients per 15-second safety poll.
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
