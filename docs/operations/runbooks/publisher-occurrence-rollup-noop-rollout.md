# Publisher occurrence rollup no-op rollout

`PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT` defaults to `off`. It permits the maintenance
reader to skip loading an occurrence's complete delivery graph only after a bounded
positive proof that the existing rollup would keep its current status without writing.
It does not change dispatch, temporal selection, quotas, permissions, receipts or SEND
retries. The manual-resolution transaction keeps its unchanged-status CAS.

The proof requires PUBLIK/SNAPSHOT routing, saved `SCHEDULED` or `IN_PROGRESS`, and a
real linked envelope containing index-1 `SENDING`, or an `ACTIVE` envelope containing
index-1 `PENDING`. The application samples time after SQL completes and skips only if
the expected status still equals the saved status. Unsupported or unenrolled occurrences and cases without a positive witness retain the
existing full reader, including terminal-only, verification-only, uncertain-only and
full-route outage states. Mixed states can skip only when the positive proof holds. SQL
errors propagate: maintenance uses its bounded retry scanner; a manual resolution's
post-commit finishing step retains its existing caller-error/replay behavior.

Before any occurrence-history probe, a scalar catalog check reads the occurrence table's
`reltuples` by its exact catalog OID. A missing, unknown or nonpositive estimate declines
the shortcut. The first seek is wholly inside the positive `CASE` branch; a separate
materialized page removes its null result before metadata is read. Native unsupported-stat
plans must show zero executions and buffers for every business-table probe. The existing
full reader remains the fallback; no runtime `ANALYZE` or planner setting is introduced.
A positive estimate is admission only; physical plan checks still cover fresh and positive
stale estimates. A positive catalog estimate does not guarantee a bounded physical
plan for every stale distribution or under accumulated invisible tuple versions.

The occurrence anchor materializes only the first key at or after the requested ID,
ordered and capped at one row. A separate parameterized LATERAL metadata seek uses
the same leading-ID lower bound, order and `LIMIT 1`, then checks exact candidate identity
after the cap. The outer reader also requires the original exact ID before business filters.
A scalar metadata equality can choose a non-leading index and read retained history
under stale statistics, even when it returns one row. A neighboring occurrence never proves the requested operation.
The key-only page and metadata boundary both need physical plan verification; a result
LIMIT or MIN aggregate alone can still scan history under stale statistics.
The linked envelopes are materialized by exact occurrence before status filters; their
existing occurrence/entity unique key bounds the set to at most two rows.
Each delivery witness materializes the first composite key at or after its required
broadcast/index/status, using the matching order and `LIMIT 1`. Exact identity is checked
after that bound; a neighboring key never proves the witness. The installed-source guard
requires both complete probes, including their bounds and final exact comparisons.

`off` performs no extra SQL or observation. `test` admits only the exact saved
occurrence: every linked envelope must contain the designated singleton chat
`-78271094414679` or channel `-78271171091799` for its stored entity type, with matching
route, bot and revision. The saved audience must be uncompressed and at most 256 bytes.
Envelope fields use exact parameterized LATERAL reads. Each recipient page first reads
up to three unfiltered keys in broadcast/occurrence/target order, then checks exact
broadcast ownership and seeks metadata with the complete composite lower bound,
matching order and LIMIT 1. All three identity columns must match after that cap.
Preserve materialized pages, both capped occurrence seeks, envelope LATERAL `OFFSET 0`,
and recipient metadata limits. More than two own rows refuses enrollment;
neighboring broadcast keys never establish recipient identity. Current editable targets and other historical
occurrences do not redefine this operation. These bounds are admission constraints,
not a replacement for fresh live test authorization.

`5`, `25` and `100` use the separate stable bot/publication namespace
`publisher-occurrence-rollup-noop-v1`. Numeric modes do not inspect saved audience JSON
or scan publication history. Changing temporal selection alone never enables this reader.

## Preview and apply

First deploy the compatible runtime with default `off` through the normal release flow.
Use the exact installed source SHA with successful `Required` and
`Analyze JavaScript and TypeScript` checks, including for preview:

```bash
./infra/scripts/vps-connect.sh publisher-rollup-noop-rollout test
./infra/scripts/vps-connect.sh publisher-rollup-noop-rollout test --apply
```

Finite modes are `off`, `test`, `5`, `25` and `100`. The controller never promotes a stage
automatically. Without `--apply`, it changes only a private preview dotenv.

The existing controller requires the shared deploy lock, exact source/image/consumer
proof, and initial dispatch plus both reader modes in all 14 API roles. Non-off modes
require dispatch already enabled. A selected mode changes only its own dotenv key;
dispatch and the other reader's value and configured/absent state remain intact.
All three pairs are reread before the atomic patch. The existing owned pause, webhook
quiescence, complete role recreation, native attestation, strict smokes and final
runtime parity checks remain mandatory. Even `off` recreates all API roles. Stores,
queues and effects are not recreated or cleared.

## Evidence and expansion

Before enabling, require same-snapshot native equivalence, writer-barrier and no-write
checks, exact bounded PostgreSQL plans at 64/10,000/50,000 deliveries, and matched complete
maintenance/dispatch profiles with explicit `off` versus `100`. Report unsuccessful or
missing cases; a disabled deployment proves no production speedup.

The final-current 18 October off/100 profile passed all 24 cells and 96 calls per
mode with matching checked outcomes/actions and frozen source/config identity.
It also retained a scheduled-64 timing flag: median 76.62 → 90.50 ms (+18.12%)
with unchanged SQL/action work and unproved cause. See the
[full profile](../../development/publisher-turn-profile.md). Keep this activation
gate open; a default-off compatibility release does not accept enabled performance.

The zero-statistics refusal uses a small uncommitted fixture and must execute no
business-table probes. A separate retained-history case prepares 10,000 parents and
50,000 foreign SENDING deliveries before the proof transaction, then checks fresh
statistics and unchanged positive estimates after 1,000 additional parents. The
two phases use distinct occurrence/envelope keys, each with one PENDING-to-SENDING
transition; their exact parent counts are 10,003 and 11,003. SQL, transaction, case
and cleanup deadlines remain unchanged. This does not prove a universal two-fetch
bound under repeated same-key MVCC churn; the earlier failing churn plan is retained.

`publication_occurrence_rollup_noop_v1` records repeated observations, admitted probes,
unchanged-status shortcuts, fallbacks and errors. These are not unique operations or
receipts. Emission is local, without entity identifiers or timers, at most once per
minute when observed work arrives. Restarts, logging failures or a final silent interval
can lose observations. Missing logs are a coverage gap. Use persisted journals for
accepted operations and outcomes; see [publication diagnostics](publisher-publication-diagnostics.md).

Use only the designated test chat and channel after fresh exact entity/bot/human checks,
with marked test content through the normal product. Require observed successful
shortcuts and unchanged persisted results. Before numeric expansion, separately accept
Publisher-specific durable correlation, an immutable accepted-source cohort and actual
shortcut-exposure coverage from
[execution plan stage 2D](../plans/2026-10-18-bot-refactoring-execution-plan.md).
The 2A0/2A sampled diagnostics and a webhook-to-DELETE cohort do not satisfy this gate,
even when additive DELETE receipt references are present. The existing sliding
created-occurrence report establishes occurrence-status evidence only; repeated
observer counters and test shortcuts do not establish a complete operation/receipt
or exposure denominator. Keep missing links, retention gaps and saturation explicit.
Until that separate acceptance, only `off` and designated `test` enrollment are permitted.
Then observe `5` and `25` for at least 24 hours each, and `100` for at least 48 hours.
Record exact source/image, UTC windows, collectors, sample gaps, fixed cohort counts,
actual exposure and comparable load. Keep NOW/scheduled and media dimensions separate;
include pending, denied, expired, cancelled and unknown outcomes without invented
completion times. Insufficient observations leave acceptance incomplete. Stop for any
new duplicate effect, wrong sanction, authority bypass, lost receipt or more than
10% p95/p99 regression at comparable load.

## Transition evidence and recovery

Each applied operation writes a bounded private record under
`/var/lib/maxim-deploy/publisher-rollup-noop-rollouts/<operation-id>.json`, with
`operation=rollup-noop`, source SHA, original/requested mode, original configured bit,
retained selection/dispatch pairs, timestamps, terminal status and runtime verification.
Records retain the existing atomic/fsync protocol, 4 KiB limit, owned `0700` directory
and `0600` file. They never authorize recovery. Original selection v1 audit readers remain
compatible; new selection records also retain the rollup pair.

Initial audit failure stops before mutation. Final audit failure reports failure even
if the runtime was verified; inspect actual state and retained evidence. An interrupted
record is not proof of rollback. Neither mode setter adopts an interrupted pause or
stopped consumers. Use the existing guarded `publisher-dispatch-disable --apply` recovery
after inspecting the cause. Its initial identity admission permits persisted mode drift;
only exact dispatch and both persisted modes on all 14 roles allow reconciliation without
recreation or final completion. Otherwise the existing full repair path runs.

For a healthy completed rollout, disable only the shortcut with preview then apply:

```bash
./infra/scripts/vps-connect.sh publisher-rollup-noop-rollout off
./infra/scripts/vps-connect.sh publisher-rollup-noop-rollout off --apply
```

Image rollback preserves dotenv and does not prove feature-off. Normally verify `off`
with this compatible controller before image rollback. If an emergency rollback occurs
first, keep any retained non-off setting as an unresolved gate before reintroducing a
consumer. All durable reader floors and uncertain-effect fences remain authoritative.
