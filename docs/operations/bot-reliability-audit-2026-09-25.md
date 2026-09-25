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
   Status: two regressions failed on baseline; correction and focused checks pass.
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
   zero known vulnerabilities. Full repository validation remains a release gate.
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
