# Publisher access refresh rollout

## Scope and invariants

The access coordinator delegates bot, actor, catalog and roster work to focused executors.
Bot proofs retain their 15-minute lifetime. Publication authority still requires fresh exact-bot,
exact-actor evidence and existing lifecycle/source-version fences. A completed queue operation
is not a permission grant. Worker concurrency stays at two; MAX budgets and ambiguous-send
recovery remain unchanged.

`MAX_PUBLISHER_ACCESS_REFRESH_MODE` accepts `off`, `canary`, or `on`. Application configuration
and `.env.example` default to `off`. Production and scale Compose default to `canary` for this
release; an explicit environment value overrides that default. Every API role receives the same
setting because several roles produce jobs for the shared queue.

- `off` uses the previous scheduling/priority policy. Additive SQL metadata can remain in place.
- `canary` separates roster scheduling for the deterministic SHA-256 bucket 0 of 10 over the
  exact bot/entity pair. Deadline priorities apply to the whole queue; legacy cohort maintenance
  must not compete with publication checks at priority five.
- `on` separates roster scheduling for every Publisher binding.

Successful roster synchronization updates `rosterCheckedAt` and `rosterRefreshAfter` atomically
with access edges. It first locks the parent chat and wins an exact-proof/lifecycle CAS on the
binding; a failed CAS grants nothing. The next periodic check is due after 30 minutes. Manual,
Start and connection/lifecycle flows retain immediate checks. Bootstrap initialization visits
at most 200 bindings per scan and spreads first checks across 30 minutes. Due roster selection
visits at most 25 rows per minute with a tuple cursor; retries leave evidence unchanged and persist
at least one minute of scheduling backoff, honoring a larger MAX retry interval or HTTP Retry-After.

Bot selection uses an independent 25-row missing-expiry lane and a 200-row dated lane ordered
by `(botAccessExpiresAt, chatId)`. Cursors advance past pending/slow work and wrap after exhaustion.
Schedules survive queue loss because enqueue never advances SQL success metadata.

## Queue compatibility

Version-one jobs accept optional `requiredBefore`, `publicationRequested` and `publicationRequestedAt` and `publicationUrgentAt` fields. The promotion marker
preserves an urgent nomination when it shares an existing scheduled job; it is scheduling metadata,
never send authority. An explicit due nomination uses its first timestamp; lookahead work becomes urgent 60 seconds before its scheduled time. That boundary survives late admission and promotion, so waiting before enqueue remains in urgent latency; promoted actors still need a proof fresh enough for publication. Old jobs without these fields remain valid.

Priorities are manual/policy checks 1, urgent publication/lifecycle checks 5, future publication preparation 8, ordinary bot checks 10,
and background roster/actor/bootstrap work 20. Bot checks become priority 5 within 60 seconds of
expiry; background jobs may age to 10 after 30 minutes, never to 5 solely from age. A publication
nomination promotes an exact pending bot or actor job without resetting its ID, attempts or delayed
retry deadline. Actor coalescing includes candidate version. Interactive replies remain separate.

Existing backlog compaction is bounded at 5,000 jobs per pass. A truncated pass must be reported
when assessing rollout latency; it does not prove the whole backlog has been reprioritized.

## Bounded publication preparation

Preflight runs every two seconds, with at most four target nominations and two targets per
occurrence. Queue admission counts priority 1/5/8 work: two queued urgent jobs close speculative
admission, and each target reserves room for both its possible bot and actor job within eight
pending preparation jobs. Already active workers add at most two tasks. This is a speculative
producer bound, not a hard cap on all due/manual jobs or a new MAX rate limit.

Each occurrence persists its target position after both nomination acknowledgements. A partial
page yields to other occurrences; a completed cycle wraps for changed audiences and lost Redis
jobs. Restart resumes the SQL position, and a failed Redis acknowledgement leaves it unchanged.
These nullable progress columns are observational/scheduling metadata, never permission proof.
Cancellation/revision fences protect the progress update; all actual sends retain their existing
author, content, schedule and permission guards. Large overload remains pending/missed under the
existing publication rules; no target is removed to improve latency.

Publication actor work may reuse the exact fresh SQL bot snapshot, including matching snapshot
checkedAt, positive state, active lifecycle and at least 30 seconds remaining. Actor persistence
rechecks the same bot proof and its expiry after the remote user probe. A concurrent renewal or
expiry retries the actor work; removal/new generation or a newer denial grants nothing. Manual,
Start and candidate-connection probes keep fresh remote bot checks.

`publisher_refresh_v1` now includes `workClass=preparation|urgent|background` and
`queueAgeBasis=all_urgent_refresh_boundaries_v3`. This basis includes manual/policy, lifecycle,
connection/recovery and access-loss checks, plus ordinary bot checks once their expiry is within
60 seconds. Bot urgency is measured from expiry minus 60 seconds, including late discovery;
publication urgency retains its earliest nomination/scheduled boundary. Actor jobs never inherit
a bot-expiry clock. Future publication preparation and aged maintenance remain separate.
The timing helper does not rewrite the execution envelope or permission/source-version fences.
Earlier v2 windows omitted urgent lifecycle/connection and expiring-bot work from the urgent
histogram; they cannot satisfy the complete urgent-coverage gate or be merged into v3 evidence.
Preserve the original reason/cohort;
compare urgent initial attempts separately from preparation, and retain admission and full-cycle
coverage as independent acceptance requirements. A new classification alone is not an improvement.
`publisher_preflight_admission_v1` reports bounded per-minute visited-target/cycle counts, observed
overdue targets, maximum admission delay and capacity-deferred ticks. Visited targets include
already-fresh or denied targets; completion of a cycle is not proof of granted access. An unvisited
backlog or a zero-sample window cannot pass readiness coverage.

## Validation and release

Run public locked API validation plus Prisma and infrastructure checks. With disposable localhost
PostgreSQL/Redis, set `TZ=UTC`, `CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL` (database name containing
`race_test`) and `MAXIM_TEST_REDIS_URL`. The access schedule PostgreSQL suite is part of
`test:postgres-races`; Redis suites run with normal API tests when their URL is configured.

Coverage includes 1,000/2,000 aged jobs ahead of urgent work at concurrency two, delayed retry
promotion, actor versions, legacy envelopes, SQL restart/queue-loss recovery, revocation during a
probe, proof races, atomic rollback of schedule/edges, indexed access paths and manual checks.
Existing publication authority/send-ledger tests remain the send-safety acceptance gate. Synthetic
queue order is not a production latency or MAX-throughput guarantee.

The scheduler schema changes add two nullable timestamps and two concurrent indexes. The evidence
release adds its diagnostic obligation table; admission adds three nullable occurrence progress
columns without backfill/default. No historical SQL is changed.
Review lock/statement timeouts and the immutable migration baseline. Leave these columns/indexes
on rollback; never edit historical migration receipts or retry partial concurrent DDL blindly.

Deploy through exact-SHA green CI and the regular queue-fenced shared API rollout. Both Compose
changes affect the common API environment. The current conservative impact classifier selects
all three active release components for a production Compose change: all 14 API roles and their
auxiliary, Major mini app static and Safety Desk static. Follow the reviewed deploy plan and preload
every selected component; PostgreSQL/Redis are never recreated by this application rollout. If clean API build capacity is
below 20 GiB, use verified CI image preload and its own archive-plus-reserve check. Do not lower
capacity floors. Required online multibot preparation separately checks and supervises a 10 GiB
filesystem reserve; modeled peak estimates remain advisory. Verify background/OCR restart
stability before proceeding.

### Interrupted index migration

If `20261002120100_index_publisher_access_schedule` fails with a lock timeout, leave the
immutable migration unchanged. Synchronize the reviewed recovery tooling only after exact-SHA
CI is green, then run:

```bash
./infra/scripts/vps-connect.sh recover-publisher-access-migration
./infra/scripts/vps-connect.sh recover-publisher-access-migration --apply
./infra/scripts/vps-connect.sh recover-publisher-access-migration
```

Review the preview before apply. The fixed helper verifies the successful additive prerequisite,
both nullable timestamp definitions, the exact failed receipt/checksum and both index definitions.
It only creates missing indexes or reindexes matching invalid indexes concurrently, under the
deploy lock with a 512 MiB table limit, 30-second lock timeout, 120-second statement timeout and
10-minute overall deadline. Unknown drift, competing failures, leftover concurrent-reindex artifacts
or unhealthy runtime abort recovery. Resolution requires both indexes valid and verifies the final
Prisma receipt. No binding/access rows, queues or release journals are changed.

Resume through normal guarded deploy with caller-only `MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1`
when the interrupted transition journal requires adoption. Never persist that flag in production
environment. The adoption path must re-prove the exact image and queue fence before release.

## Canary acceptance

Keep the initial deterministic 10% cohort for at least 24 hours. Aggregate identifier-free
`publisher_refresh_v1` windows by `reason`, `workClass`, `retrying` and `cohort`. Keep the
measurement basis/release separate; never fold older unclassified windows into the new urgent SLA. `proofOutcomes` counts actual
stage verdicts; `stageAttempts` distinguishes work attempted from deferred jobs. Use roster stage
attempts for periodic maintenance per eligible cohort/time, and compare the same traffic window.
`deadlineProbes` and `confirmedBeforeDeadline` describe observed jobs carrying a bot deadline;
they do not estimate unscheduled bindings or prove fleet-wide coverage by themselves.

The evidence release adds `deadlineEvidenceBasis=committed_proof_attempt_v2`: the attempt
counter uses the acknowledgement time of the committed bot proof, before optional catalog,
roster or reply work. Forwarded candidates acquire that time only after their materialization
transaction succeeds. Superseded probes remain unresolved in attempt metrics. Do not merge
old end-of-job observations with this new basis or treat either attempt ratio as the SLA denominator.

`publisher_access_refresh_obligations` stores one diagnostic obligation for the exact
bot/entity/old-proof timestamp/expiry once the old proof enters the five-minute renewal horizon.
The scanner records selected obligations before enqueue; a successful probe also registers a
replaced eligible proof that was not previously scanned. A repeated scan or retry cannot reset
the deadline or overwrite the first settlement. A pending obligation remains unsuccessful after
expiry, including when its binding is subsequently deleted. Confirmed denials are separate and
never count as successful renewals. SQL evidence is not a permission source or a send ledger.
Telemetry errors emit identifier-free `publisher_access_evidence_gap_v1`; they leave committed
permissions intact but make the affected acceptance interval incomplete.

Each scheduler scan emits `publisher_access_obligations_v1` for the previous complete UTC hour.
Replace repeated reports for the same release/from/to/cohort, never sum overlapping copies.
The indexed source is capped at 50,001 rows, with aggregates over at most 50,000 and explicit
`sourceTruncated`. A complete source reports obligations, confirmed-in-time, confirmed-late,
denied, unresolved and registered-after-deadline counts. Empty/missing reports do not prove an
empty fleet. Combine these denominators with complete expiry cursor cycles and the independent
population census: registration alone cannot prove that a never-scanned binding was covered.
Begin acceptance only after a full initialization/expiry scan cycle and instrumented warmup;
discard release gaps, missing windows and mixed measurement semantics. The first partial hour
is not a complete acceptance hour.

Evidence remains available for seven days. Each scan deletes at most 500 expired rows from
this new diagnostic table only; no binding, access edge, receipt, publication or send ledger is
deleted. Rollback leaves the additive table in place. Old runtimes do not write obligations, so
their intervals cannot pass the new evidence gate. Periodic compaction now emits its bounded
result as `publisher_access_compaction_v1`, including truncation, even when no jobs changed.

For a bounded population snapshot, first review the fixed plan, then run:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-access-census --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-access-census
```

This opt-in report uses the existing six binding metadata grants and the audit session's time,
memory and read-only limits. An unfiltered primary-key scan stops at 50,001 rows before any
status filter, cohort hash or aggregate. Only counts over at most 50,000 rows leave SQL;
`source_truncated` explicitly marks an incomplete population. The SHA-256 bucket matches the
runtime's compact JSON bot/entity pair. Both cohorts report active/admin/fresh/expired populations.
`active_bot_scopes` must be one and agree with the attested runtime scope before using a complete
snapshot as a population denominator. No new grants or application restart are required.

Collect comparable snapshots throughout the measured interval. Normalize only periodic
`binding_maintenance` roster attempts against comparable eligible binding/time exposure;
webhook/manual roster work is separate. Sparse snapshots, population changes and truncated
samples must remain explicit uncertainties, not be converted into precise binding-hours.
Fresh evidence in a snapshot cannot retrospectively resolve superseded jobs or prove that a
previous deadline was met. This report never grants access or repairs/replays a publication.

### Acceptance protocol for the combined priority refactoring release

Freeze the release identity and protocol before collection. The interrupted earlier observation
is historical only. Start with instrumented warmup; require complete expiry, missing-expiry,
roster-init and roster-due cycles and healthy release/fleet readiness. Then use the next full UTC
hour as the acceptance boundary and collect at least 24 consecutive complete UTC hours. Retain
only allowlisted aggregates; keep old and new measurement bases in separate archives. Metrics
readers must accept the `reused` bot outcome without interpreting it as a new committed proof.

Minimum sample requirements for this run are 1,000 initial urgent attempts and 10,000 exact
obligations overall, with at least 1,000 obligations in each canary/control cohort. These floors
allow assessment of observed tail rates; they are not statistical confidence guarantees. Report
per-reason urgent counts and low-volume classes separately. Missing or insufficient traffic extends
the canary; do not generate synthetic sends into user chats. Confirmed denials, late registration,
late confirmations and unresolved obligations remain in the fixed denominator.

Use population snapshots at five-minute cadence with gaps no larger than ten minutes. The
periodic roster denominator is active confirmed-admin/owner binding exposure for each cohort,
aligned to the exact metric interval. Report integral estimates and conservative exposure ranges
from neighboring snapshot minima/maxima; record population changes. If either population changes
by more than 5% within a snapshot interval, or cohorts show material composition differences,
collect narrower or stratified read-only evidence before claiming comparable savings. Require the
50% savings threshold even under the conservative exposure estimate. Other reasons and manual/
webhook calls are reported separately from `binding_maintenance`, including all its retries.

Replace repeated obligation reports for the same hour; never sum them. Missing hours, truncated
sources/compaction, evidence gaps, unproven scan coverage or a changed release keep acceptance
pending. Collection gaps may only be filled by bounded overlapping reads with verified release
identity. Aggregate worker completions do not resolve missing obligations or prove send safety.
Compare shared webhook preparation limits and duration, outbox oldest-eligible progress, MAX/
SQL/Redis errors, send/access/moderation outcomes and complete capacity windows. Review the
release's [preparation](webhook-preparation-bounds.md) and [outbox scan](webhook-outbox-fair-scan.md)
runbooks alongside Publisher evidence.

The repository-controlled Compose default is sufficient for a later reviewed `on` rollout only
when a fresh preflight confirms no overriding runtime environment value. Recheck that condition
at promotion; deploy every selected component through the ordinary guarded wrapper and attest
all 14 API roles. A missing override today is not a permanent configuration guarantee.

Required gates under supported load:

- Initial urgent queue-age histograms: p95 at most 5 seconds and p99 at most 15 seconds.
- At least 99.9% scheduled bot confirmations before expiry, with sufficient deadline observations
  and `publisher_access_scan_v1` confirmation that scans completed full cursor cycles without errors.
- At least 50% fewer periodic roster calls per comparable binding/time versus control/baseline.
- No increase in denied/stale sends, ambiguous replay, API failures or sustained moderation lag.
- No lost manual operation identity, missing roster recovery or scan/compaction truncation ignored
  in the measurement.

Promotion to `on` requires these measured gates, a recorded start/end window and exact deployed SHA.
Low samples or missing windows mean acceptance is pending. An immediate release smoke cannot
substitute for the full observation window. Return to explicit `off` through the normal shared API
environment rollout if regression appears; retain the durable SQL state and pending job identities.
