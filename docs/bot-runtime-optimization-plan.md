# Bot Runtime Optimization Plan

## Scope

This iteration improves the existing webhook-to-action pipeline without replacing NestJS,
BullMQ, Prisma, or MAX transport. Modernization means bounded resource use, reproducible cost
budgets, clear ownership, and measurable production acceptance. It does not include a UI redesign,
framework migration, broader bot permissions, native OCR policy changes, or production load tests.

## Delivery Checklist

- [x] Inspect the current runtime and record a read-only baseline.
- [x] Reduce redundant mirror lookups and coalesce concurrent membership heartbeat writes.
- [x] Bound routing caches and reduce repeated assignment scans without changing queue ordering.
- [x] Add deterministic performance/safety regressions and a bounded offline capacity report.
- [x] Pass local validation, exact-SHA CI, scoped deployment, and production observation.

## Baseline And Decisions

The preceding incident fix remains in place: confirmed absent profanity authors do not cause
retries, pristine settled receipts do not scan BullMQ queues, and retained timeout settlement is
paced separately from due retries. Do not reimplement or weaken those safeguards.

The initial read-only sample for this iteration found normal mode, ready ingress/admin APIs, and
low-single-second queue lag. There is no current evidence justifying larger PostgreSQL pools or
more moderation concurrency. Production remains the sole primary, so investigate query cost with
the fixed audit catalog and use local/CI fixtures for load and adversarial cases.

Code inspection identified these avoidable costs:

1. `touchMirroredReceiptMembership` reads the chat owner and passes it to a heartbeat method that
   does not use the owner. Remove that lookup only from this observational path; authoritative
   routing/access reads remain fresh.
2. The heartbeat TTL is populated only after a write finishes, allowing simultaneous observations
   of one chat/bot to issue the same update. Coalesce only in-flight writes for that key, publish
   cooldown only after success, retain retry behavior on errors/missing memberships, and cap the
   completed cooldown cache.
3. Adaptive routing counts the same active assignment map once for every candidate shard. Build
   queue/worker occupancy counts once per selection, preserve existing scores/ties/expiry rules,
   and cap retained assignments. Cache eviction must re-read outstanding work before choosing a
   route; a cached assignment is never authority to bypass database ordering fences.
4. Capacity samples already have a private allowlisted archive, but comparisons require ad hoc
   commands. Add a bounded local report with explicit time windows, sampling coverage, lag
   percentiles, readiness/fleet/fence failures, and optional before/after comparison. These are
   sampled oldest-queue-lag statistics, not request latency or event-processing percentiles.

## Acceptance Budgets

- A prepared mirror performs zero chat-owner reads for its heartbeat.
- A burst of concurrent observations for one chat/bot performs one heartbeat update. Different
  chat/bot keys remain independent. Failed writes do not create a successful cooldown.
- Adaptive shard selection visits the active assignment map once rather than 16 times. Existing
  deterministic routing outcomes, critical command routing, and outstanding-work fences still pass.
- In-scope heartbeat and assignment caches have explicit entry ceilings. Eviction may trigger a fresh read, never a grant
  of access, skipped sanction guard, or migration of live work to another queue.
- Offline reporting performs no network or database calls, accepts only bounded private archives,
  distinguishes insufficient coverage from healthy observations, and never emits identifiers,
  payloads, free-form errors, or secrets.
- Local checks and exact-SHA CI must pass before deployment. Deploy the shared API image to every
  API role through the normal queue fence, without recreating Postgres, Redis, or static services.
- Verify the final release with a read-only observation window: exact fleet/image consistency,
  released queue fence, ready ingress/admin endpoints, and no sustained queue regression. Record
  bursts and recovery honestly; a single fast health sample is not a throughput guarantee.

## Validation And Rollback

Use the public locked API test/check scripts. Cost assertions use call/iteration counts instead of
machine-sensitive millisecond thresholds. Retain multi-bot, removal/reactivation, error, retry,
expiry, cache-capacity, and persisted-shard tests. Run tooling/infra checks for the offline report.

Use the existing isolated 2x/4x ingress harness only on an explicitly configured disposable
environment. Do not manufacture a production acceptance result when that environment is absent.

The release needs no schema migration or new secret. Use the manifest-aware rollback wrapper if
runtime validation fails; never clear queues, lower disk floors, or bypass exact-SHA CI to proceed.

## Results

The 233 focused API tests pass. New regressions first failed on the former behavior and now prove
one heartbeat write for 100 concurrent same-key observations, one assignment scan instead of 16,
and 10,000-entry ceilings with persisted-shard recovery after eviction. Production measurements
will be recorded after deployment; these operation-count improvements are not claims of equivalent
end-to-end speedups.

The offline report has 13 passing tests covering cross-hour windows, missing/sparse samples,
unknown values, comparison validity, private-file checks, bounded input, output redaction, and
the distinction between historical restart totals, new increases, counter resets, and unfinished
future windows.

### Production Verification

- API source `ec530cd3f39fcd9cb09581421531d94557cb3d18` passed the full local API check:
  532 suites and 11,941 tests, plus typecheck/build. Static, documentation, and infrastructure
  checks passed. The 17 locally skipped integration suites require their external services;
  exact-SHA CI passed its PostgreSQL, Redis, native-image, and other required jobs plus CodeQL.
- The verified CI image was preloaded and deployed through the normal wrapper. Release
  `release-20260914T105707Z-ec530cd3f39f` passed ingress/admin live and ready, public live, and OCR
  isolation/raster/shadow smokes. No schema migration, stateful-service recreation, static deploy,
  queue purge, manual governor override, or concurrency increase was required.
- The post-release capacity window `2026-09-14T11:02:48Z` through `11:07:48Z` contained 20 samples.
  Ingress/admin readiness and queue-fence checks had zero failures. Sampled queue lag was
  0.101-1.431 seconds, with p50 0.495 and p95 1.293 seconds. System mode returned to normal/healthy.
- Docker inspection confirmed all 13 API roles running with zero restarts. The isolated OCR native
  sandbox recycled once, producing a transient fleet alert; it is separate from the API roles.
  This behavior was also present in the baseline and remains visible in the report. The complete
  observation window is therefore not labeled uniformly healthy simply because it ended healthy.
- Equal three-minute windows were inspected without claiming a causal speedup. The baseline
  `10:10:58Z-10:13:58Z` had sampled queue-lag p50 0.272 and p95 2.298 seconds; the post-release
  `11:04:48Z-11:07:48Z` window had p50 0.613 and p95 1.431 seconds. The report refused an automatic
  comparison because the baseline restart counter reset. Traffic and startup conditions also
  differ; the deterministic operation-count tests are the proof of reduced algorithmic work.
- The 2x/4x end-to-end load profiles were not run: no isolated target was configured and the local
  Docker daemon was unavailable. Production was observed read-only, not used as a stress-test target.
- A final local-tool-only correction rejects windows that have not finished yet. It does not change
  the deployed API image or perform production operations.

## Offline Comparison

Run this locally against the private archive created by `monitor-readonly`; it makes no SSH,
database, or MAX calls and does not modify the archive:

```bash
node infra/scripts/monitor-capacity-report.cjs \
  --from 2026-09-14T10:02:55Z --to 2026-09-14T10:07:55Z \
  --compare-from 2026-09-14T09:55:55Z --compare-to 2026-09-14T10:00:55Z
```

Use actual captured windows when comparing a release. Each window must span 1-60 minutes; the
baseline must be earlier, non-overlapping, and equally long; both windows must have ended.
`--archive-dir` overrides the normal
XDG state location. Missing files, inadequate cadence, unknown health data, and stale metrics are
visible rather than interpreted as successful observations. The file/record budgets are inherited
from the existing archive format. CLI errors never echo archive content.

The JSON basis is `sampled_oldest_queue_lag`, not request latency. A negative change in p95 is a
descriptive comparison, not proof of causation under different production traffic. No additional
background monitoring process or external observability service is installed.
Window `status` describes all observations in the selected interval; `last` is the final snapshot.
