# Outcome cohort indexes: online preparation and interrupted builds

This procedure covers only the two additive observation indexes below. It does not authorize
replaying bot actions, changing queues, widening historical multibot preparation or repairing
another migration. Follow [infrastructure notes](../../../infra/AGENTS.md) and the existing
[production operation boundaries](../../development/production-operations-reference.md).

| Selector    | Immutable migration                                 | Index and ordered keys                                                                                  | SHA-256 of migration.sql                                           |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `delete`    | `20261017010000_index_delete_outcome_cohorts`       | `moderation_delete_intents_status_created_id_idx(status, created_at, id)`                               | `c7e7dfd3f31d3ca4675cf7c5f322a4343dc3ce4951688b905a0d3c277f9de76b` |
| `recipient` | `20261017010100_index_publication_delivery_cohorts` | `managed_broadcast_deliveries_dispatch_status_created_id_idx(dispatch_profile, status, created_at, id)` | `4d2816562cfca8e947f36b01796caa42f518927761d4ed9a48289a89203c9e27` |

Both indexes are nonunique, ordinary persistent B-trees in `public`, with default key options,
collations, operator classes and tablespace. There is no predicate, expression or INCLUDE list.
Do not drop an older index or edit either migration. Application rollback retains these indexes;
they add no columns, authority, reader floor or history rewrite.

## Ordinary release

Use the normal exact-green-SHA deploy entrypoint. Its protected transaction performs a bounded
read-only preflight before image builds. After images and the independent old multibot preparation,
it invokes the fixed outcome supervisor before any webhook queue pause or service recreation.
The new stage is not conditional on the old `20261005020000` effects cutoff.

Preparation verifies the complete immutable source prefix and genuine successful Prisma receipts
for every prerequisite. At most one pending target is exposed to a minimal image-side Prisma
client. The second target starts only after the first target's exact index and receipt are proved.
No unrelated pending migration runs in this stage. Ordinary Prisma deployment later observes the
completed receipts; the deploy rechecks both exact indexes after that step.

The fixed reader also recognizes four historical receipt variants through
`scripts/agent/outcome-cohort-historical-compatibility.mjs`. Each requires its exact name and
SHA-256, a finished single-step receipt, pinned current source and successor receipts, and
matching current catalog postconditions in the same bounded read-only snapshot. Unknown hashes,
missing successors, unfinished or duplicate receipts and schema drift still stop preparation.
The allowance neither executes historical SQL nor changes migration receipts or runtime settings.

| Historical migration                                 | Exact historical SHA-256                                           | Content evidence                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `20260301143000_add_commercial_scoring_settings`     | `bf0f08ea91e490406c5f04fe78895bdacd41eb2a475054b4b509390126068c99` | Git commit `5e5b3ef3f249838915805ec267963b39c18da197`                                   |
| `20260301173000_add_delete_bots_messages_toggle`     | `e2be732e2c92320c22f82d89d827479532e256039ceb97e7316e200c983ee55e` | Git commit `f01eca24604f1bbd09ad5bd8313e86a13f82d7b9`                                   |
| `20260311153000_add_night_mode_open_message_enabled` | `6327681695854247dfe8d06a42f917ed6d2af9a61fce10cdff718446219c072b` | Exact 236-byte reconstruction matching the stored digest; original commit not recovered |
| `20260311160000_add_night_mode_open_message_text`    | `65b381f01dcd3e2870c9290118941d8ee88f977c67232ba31332d730e9c9dc2b` | Exact 96-byte reconstruction matching the stored digest; original commit not recovered  |

The first variant's phrase tables and three obsolete fields were removed by later migrations;
their absence and the surviving enum/columns are checked. Bot-removal and night-mode flags now
have default `false`, as required by `20260726120000_disable_bot_settings_defaults`. Both removed
night-mode names additionally require the exact combined migration
`20260316113000_add_night_mode_open_message`. Catalog evidence proves present schema compatibility;
it does not reconstruct historical user-setting values or the original deployment sequence.

Admission for each pending target requires 120 seconds of fresh ready ingress/admin observations
with queue lag at most 10 seconds. Storage is sampled throughout. Missing or stale observations,
device drift, lag above 120 seconds, or lag above 30 seconds continuously for 90 seconds abort only
the owned attempt. PostgreSQL executes maintenance work; the client's 512 MiB/0.5 CPU limits do not
limit PostgreSQL CPU or I/O.

| Limit                               | DELETE       | Recipient   |
| ----------------------------------- | ------------ | ----------- |
| Initial table-size scope            | 4 GiB        | 512 MiB     |
| Statement timeout on DDL session    | 1800 seconds | 600 seconds |
| Temporary-file limit on DDL session | 2 GiB        | 512 MiB     |
| Lock timeout                        | 5 seconds    | 5 seconds   |
| Maintenance memory                  | 128 MiB      | 128 MiB     |
| Parallel maintenance workers        | 0            | 0           |

One 3000-second attempt budget includes both admissions, builds, verification and cleanup; work
stops with a 60-second cleanup reserve. Storage admission enforces 10 GiB plus the estimated pending
indexes, maximum serialized temporary allowance and visible WAL allowance on each physical device.
Shared-device roles add their incremental budgets once above a single 10 GiB floor. The index
estimate takes the maximum of retained table bytes, twice a matching existing index and a checked
bytes-per-estimated-row allowance. Neither the estimate nor `max_wal_size` is a worst-case WAL cap.
Continuous sampling preserves the 10 GiB floor; it cannot promise the absence of between-sample
changes. Do not lower these limits through environment overrides.

When both exact receipts/indexes are already complete, preparation returns after attestation.
One-time build-size ceilings must not prevent later releases as already indexed tables grow.
If only DELETE is complete, prepare recipient only.

Logs identify the parent attempt, exact `maxim-online-<uuid>` child, phase, start/deadline, last
successful storage/runtime observations and child exit/cleanup result. Preserve missing intervals
and failed outcomes. Do not infer activity from a launched process or report cleanup as successful
without exact session/container absence.

## Interruption and recovery decision

1. Stop release progression. Preserve the failed Prisma receipt, original SQL/checksum, source SHA,
   immutable image identity, attempt log and partial index. The ordinary adapter never retries,
   resolves, drops or reindexes a failed target. Keep the previous API runtime serving work.
2. Establish cleanup for the exact UUID-tagged client and matching PostgreSQL sessions. Removal of
   that exact created/exited container prevents a queued start or reconnect. Near-prefix/foreign
   sessions, production API containers and sibling projects are outside cleanup scope. Unknown
   cleanup blocks further work; never unlink a deploy lock or discard its journal.
3. Under the protected deploy lock, collect the fixed bounded state preview for these two targets
   using the same reviewed source and full Compose selectors. Retain receipt identity/checksum,
   finished/rolled-back state, safe failure classification, index definition and validity flags,
   repair artifacts and active builders. Do not print connection URLs or raw Prisma logs. Missing,
   capped, foreign or contradictory evidence blocks recovery.
4. Bind a concrete recovery proposal to one target and the original failed attempt. Reuse the same
   storage/layout scope, runtime admission, per-statement settings, total deadline and exact owned
   cleanup. No generic recovery runner or operator-supplied SQL path is introduced by this release.
   A production writer for the selected proposal must be reviewed separately before execution.

The read-only preview entrypoint is
`node infra/scripts/outcome-cohort-online-state.mjs preview <full Compose global selectors>`.
Invoke it from the exact reviewed checkout with the deployment's structured `--env-file`, project
and ordered Compose files. It accepts no migration name, index name, SQL or repair operation. A
preview can truthfully report a blocked state; that result grants no permission to execute DDL.

The only candidate decisions, after that preview, are:

| Proven retained state                                                                                                        | Candidate reviewed recovery; never automatic                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No index; exact failed attempt and immutable checksum proved                                                                 | Create the one fixed concurrent index under the same budgets, then verify every persistent migration effect before receipt settlement. A clean pre-SQL lock failure may instead use an explicitly reviewed rollback-of-failed-receipt and normal retry. Choose one route for the incident. |
| Index has the exact expected definition but is invalid                                                                       | Reindex that exact index concurrently under the same supervision. Preserve its failed receipt until successful postconditions.                                                                                                                                                             |
| Index is exact, valid, ready and live; exact failed receipt still unfinished                                                 | SQL-free receipt settlement may be reviewed only after matching provenance and proof that the complete one-index migration's persistent effects exist.                                                                                                                                     |
| Index is valid but receipt is absent/foreign; definition differs; another builder exists; `_ccnew`/`_ccold` artifact remains | Stop for review. Do not infer migration success from a name, drop artifacts, widen scope or retry automatically.                                                                                                                                                                           |

When receipt settlement is justified, use the public Prisma CLI in the exact immutable image under
the same protected lock. Verify its real receipt transition and checksum afterward, retaining the
original failed history. Never write `_prisma_migrations` rows directly, fabricate `finished_at`,
change SQL bytes, use an unrelated successful receipt or suppress catalog mismatch.

The existing multibot and small publication recovery commands have different fixed identities;
they cannot be reused by passing these names or raising their table-size limits. A failed concurrent
reindex may leave repair artifacts; preserve them and review the new state instead of looping.

## Validation and acceptance

Focused unit tests cover prefix exclusion, exact checksums, capacity reserves/shared devices,
both admission windows, deadline cleanup and old client compatibility. The native fixture creates
its own disposable database, applies actual prerequisite migrations, checks concurrent writers,
retained cancellation, genuine receipts, drift and conservative size estimates. Run it only with
the existing isolated-store wrapper and `MAXIM_TEST_POSTGRES_URL`/`TZ=UTC`.

The separate API-image smoke verifies the packaged new runner/imports, actual immutable migrations,
receipt readback and minimal read-only client isolation. It does not claim to observe a real
120-second production admission; timing coverage is separate and the production supervisor always
uses real clocks. Native infra coverage is explicitly wired into PostgreSQL CI rather than relying
on the store-less static job's skipped tests.

The historical native fixture executes the four exact SQL files in a disposable database so
Prisma itself creates the original receipts. Explicit fixture-only schema convergence precedes
the remaining current migrations; this is not a reenactment of production history. The ordinary
preparation command must then add only the two target receipts and preserve every historical
receipt. Separate negative cases reject catalog drift and missing or conflicting evidence. Never
run fixture convergence on production or install reconstructed SQL as new source migrations.

Before release require affected public checks and exact-SHA `Required` plus CodeQL. After normal
deployment verify the shared API image across all roles, strict smokes, immutable manifest and
owner-authenticated cohort/evidence reads. Missing samples or an insufficient cohort leave product
acceptance incomplete. No live history scan, production EXPLAIN ANALYZE or public-chat diagnostic
message is needed for index preparation.
