# Bot Reliability Audit: 2026-09-25

## Scope

Risk-prioritized audit of webhook admission/persistence, multi-bot action routing,
send/member-action ambiguity, Publisher isolation, worker shutdown and production
health. Source baseline: `5f8bb496`. Existing user documentation is preserved.
Automated tests and short read-only observations do not prove every live workflow.
No participant sanctions, ambiguous-send replay, queue purge, policy promotion or
production load test is part of this work.

## Findings And Plan

1. P1, worker shutdown: `discoverRegisteredRuntimeWorkers` discovers Nest
   `WorkerHost` instances only, but `DefaultWebhookLeaseManagerService` constructs
   the default-shard BullMQ workers directly, even in static/off mode. Those
   consumers remain active until Nest destroys providers, overlapping dependency
   teardown. Register their ownership explicitly with the existing shutdown
   mechanism; synchronously freeze worker creation/rebalancing before taking the
   worker snapshot, then use the existing bounded pause/drain/close sequence.
   Test discovery, active work, force-close and an in-flight synchronization race.
   Status: two regressions failed on baseline; correction, full checks and
   production deployment completed.
2. P2, dependency security: production audit reports Fastify advisories
   `GHSA-w2qp-rph6-63g4` and `GHSA-3m5p-2c4r-xxw2`. Upgrade the existing override
   within Fastify 5.x to a reviewed patched release; regenerate the lockfile with
   npm and validate HTTP boundaries and every image consumer. Do not force a Nest
   major upgrade. Lockfile regeneration also correctly classified Prisma's
   `mysql2` as production, exposing `GHSA-rgwj-5xj2-c3m3`; update its existing
   security anchor to 3.23.1. Full audit additionally identified advisories in
   js-yaml, qs, browserslist, baseline-browser-mapping, humanfs and Vitest.
   Apply compatible fixes only. Scope the fast-uri 3.x security override to 3.x
   requests so Fastify's newer serializer can use its declared 4.x dependency.
   Status: compatible updates applied; full and production-only npm audits report
   zero known vulnerabilities. Full validation, exact-SHA CI and deploy passed.
3. P2, production headroom: baseline capacity samples report roughly 9 GiB free
   on Docker storage, below the 20 GiB shared API build floor. Use exact-SHA CI
   preload and normal reuse-only deployment if all capacity checks pass. Do not
   lower disk floors or run shared-host Docker garbage collection.
4. P2, operational triage: poll repair reports inconclusive 404 lookups and
   Publisher work is deferred for missing actor access. Retained FAILED webhook
   rows are history, not automatically a current backlog. Keep exact-absence and
   Publisher access guards; do not convert these symptoms into automatic replay
   or destructive cleanup without exact intent/access evidence.

## Baseline Evidence

- Node 24.16.0; early generator/export/HTTP-boundary preflight passed.
- Local source and VPS checkout both report `5f8bb496`.
- Ingress/admin readiness, PostgreSQL and Redis passed initial checks. All 14
  API roles matched the expected image and identity without duplicates. One
  capacity sample failed the auxiliary fleet attestation while the OCR sandbox
  recycled; subsequent fleet checks passed.
- Bounded queue catalog: 1,714 retained FAILED rows, 12 QUEUED and 48 RECEIVED;
  oldest current QUEUED/RECEIVED age was two seconds at that sample.
- Capacity samples included a roughly ten-second lag burst followed by recovery
  below one second. Action windows had noncritical failures; no error-free
  operation or sustained throughput claim is made.
- Eight capacity samples in 11:48:21-11:50:21 UTC had lag p50 0.998 seconds,
  p95/max 10.044 seconds, zero readiness/fence failures and one fleet-attestation
  failure. The interval ended in the stabilizing recovery state, not uniformly
  healthy. The reported restart increase of 35 crosses an invalid auxiliary
  attestation: Docker inspection showed retention at one historical restart and
  OCR sandbox at 35, with its latest start at 11:48:24 UTC. It is not evidence of
  35 fresh API crashes. No cause is attributed to the shutdown defect.
- Production dependency scan: two moderate entries (Fastify and its adapter),
  zero high/critical entries before the lockfile reclassification described above.
- Baseline API check passed 588 suites / 13,156 tests, typecheck/build and ten
  storage tests. Environment gates skipped 24 suites / 173 tests and one real
  PostgreSQL storage race. Final focused shutdown/HTTP tests passed 54 tests after
  the runtime correction and dependency updates, including all four lease modes,
  stopped timer admission and the in-flight synchronization race.

## Release Gates

- Prove new regressions fail before runtime corrections, then pass after them.
- Complete API, contracts, Prisma, mini app/admin, static, infra and docs checks;
  include real external-service/native coverage through exact-SHA CI.
- Submit only owned files through the staged commit/push wrapper.
- Require green `Required` and `Analyze JavaScript and TypeScript` checks for the
  exact release SHA. Root dependency changes select all active image components.
- Preload reviewed immutable images, run the normal scoped deploy and strict
  smokes, then capture another bounded read-only capacity window.
- Record skipped gates, deployment blockers and remaining operational work here.

## Local Validation

- The staged commit/push wrapper completed the full repository check: static
  analysis/refactor guards, 535 tooling tests, 424 infra tests, documentation,
  299 contract tests, API typecheck/tests/build, Prisma policy/validation, 1,382
  mini app tests and production build, and 15 Safety Desk tests/build.
- Safety Desk browser smoke passed desktop and narrow viewports. Mini app smoke
  passed 13 iPhone scenarios with layout, contrast and accessibility checks.
  These fixture-backed checks are not live MAX dialog acceptance.
- Multi-bot fixture smoke passed 22 assertions, covering 1/2/3/6 bots, denied
  primary, channel deletion permissions and draining standby exclusion.
- A bounded cached subscription read at 12:04 UTC reported all six moderation
  bots healthy/configured, zero missing updates/errors/operational warnings;
  the reconciler snapshot was 52 seconds old.
- A later bounded five-minute log sample from four default-shard roles contained
  14 no-permission warnings and 13 MAX 404 warnings. Other warnings also existed;
  the sample does not establish a complete error distribution or authorize replay.
- The fixed PostgreSQL activity catalog showed idle pool headroom and one active
  delete-intent query waiting for a data-file read at eight seconds. One sample
  cannot establish a persistent database bottleneck or justify larger pools.
- Manifest-aware image reclaim dry-run found no eligible unused MAXIM images.
  No images, containers, volumes, build cache or application data were deleted.
- Local Docker daemon is unavailable. Native/image and real PostgreSQL/Redis
  integration checks therefore remain exact-SHA CI gates.
- Runtime source submitted: `7e53840bb566ff2bc243a1a7b808889ea5fdc7fc`.

## CI And Delivery

- [CI](https://github.com/GameclubPro/MAXIM/actions/runs/36133246850) and
  [CodeQL](https://github.com/GameclubPro/MAXIM/actions/runs/36133246961) passed
  before preload/deploy. The high-severity CodeQL alert gate also passed.
- API CI passed 588 suites / 13,165 tests. Its separate real-Redis lane passed
  17 suites / 194 tests. PostgreSQL lanes passed 43 race tests, three traffic
  policy tests, 27 report recovery tests and all 11 retention storage tests.
  Migration/schema parity, the commercial benchmark, all three images and native
  OCR isolation/UDS/raster/process-clean smokes passed. The broad API lane still
  reports 24 environment-gated suites / 173 tests skipped; do not interpret
  successful CI as live conversational or production load acceptance.
- All three immutable images were loaded through the normal wrapper after exact
  checksum/revision checks. API archive size was 732,314,112 uncompressed bytes;
  the API preload had 9,397,489,664 free bytes and enforced the 4 GiB reserve.
  Static preloads also passed their reserve checks. Deployment reused the images,
  without a VPS build, lowered disk floor, emergency bypass or image cleanup.
- The VPS synchronized to the exact source SHA, found no pending migrations and
  fenced webhook admission/active work across the mixed-version interval. All
  14 API roles, the OCR auxiliary and both active static services converged to
  the reviewed SHA. PostgreSQL and Redis were not recreated.
- The local SSH client disconnected with `Broken pipe` during rollout. Read-only
  inspection proved the original server-side deploy process was still running;
  no second deploy, queue-owner takeover or manual resume was attempted. The
  original process finished the rollout and committed its own normal manifest.
- Queue lag peaked at approximately 224 seconds during the transition. Readiness
  recovered inside the normal configured window: the 12:34:40 UTC observation
  was ready with 0.657-second lag, followed by zero lag at 12:34:55. No readiness
  timeout or concurrency override was used.
- Validated release: `release-20260925T122801Z-7e53840bb566`, committed at
  `2026-09-25T12:34:44.271Z`. Its manifest records strict ingress/admin live/ready,
  public live, static and native OCR smokes; all three component source SHAs match
  the release commit and `emergencyReason` is null.
- The running API reports Fastify 5.12.1. At 12:36 UTC the cached subscription
  snapshot was 16 seconds old: all six moderation bots healthy/configured, with
  zero missing updates, reconciliation errors or operational warnings.
- The deploy repeated the existing missing `POSTGRES_PASSWORD` compatibility
  warning. Securely verify/configure the current password before a separately
  planned PostgreSQL recreation; no password was read out, rotated or changed.

## Post-Release Observation

- The 12:35:16-12:37:16 UTC window contained eight complete capacity samples:
  lag 0.077-8.164 seconds, p50 0.212, zero readiness, queue-fence or fleet-identity
  failures and zero restarts. All samples remained in the configured stabilizing
  recovery window, so the interval is reported as degraded, not uniformly healthy.
- The follow-up 12:38:40-12:40:40 UTC window also had eight complete samples:
  lag 0-1.393 seconds, p50 0.232, with zero readiness, queue-fence, fleet-identity
  failures or restarts. The first five samples were still stabilizing; the last
  three were normal/healthy. The final archived sample had 0.104-second lag.
  A fresh 12:40:40 health read confirmed both APIs ready and normal/healthy.
  These are sampled oldest-queue lags, not a causal throughput improvement claim.
- The canonical mini app and its JS/CSS assets returned 200. Public Safety Desk
  and support APIs returned 404; unauthenticated admin access returned 401.
- Action windows still contained noncritical failures, consistent with the
  operational issues above; no error-free MAX operation claim is made.
- Docker storage remained about 97% full, with approximately 7.7 GiB available.
  Successful reuse-only delivery does not resolve that continuing capacity risk.
- Local monitor processes completed and removed their private temporary logs;
  generated smoke screenshots were removed after their results were recorded.
  Existing user notes were preserved. The report-only follow-up requires no
  additional runtime deployment.

## Remaining Operational Work

1. Disk capacity: review growth/retention of the stateful volumes and size an
   expansion with backup/restore headroom. Prefer storage expansion over removing
   protected images or production data. No paid infrastructure change or data
   deletion is implied by this audit; reuse-only deployment is not a capacity fix.
2. Entity access: administrators must restore the exact bot/actor permissions
   where required. Re-probe through normal access refresh, then recover only
   independently proven non-deliveries. Never borrow Major credentials for Publik.
3. Retained failures: add or use reviewed, bounded reason/age diagnostics before
   selecting exact receipts for recovery. Preserve attempted-send/member fences,
   timeout quarantine and message-specific absence proof.
4. Capacity evidence: observe a representative busy window with stable fleet
   identity. Correlate actual restart deltas, per-role memory and query-family
   waits before changing concurrency, pool sizes or caps. Keep OCR shadow and
   its native isolation/recycle behavior; metrics cannot authorize promotion.
5. End-to-end acceptance: use only the designated test chat/channel, verified
   entity types and uniquely marked test content for live command/moderation/
   publication tests. A disposable environment is required for 2x/4x load tests.
