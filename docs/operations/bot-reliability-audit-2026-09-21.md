# Bot Reliability Audit: 2026-09-21

## Scope And Method

This is a risk-prioritized source, regression-test and bounded production audit,
not proof that every workflow is defect-free. Inspect ingress/authentication,
multi-bot routing, irreversible actions, Publisher isolation/recovery, runtime
shutdown and existing moderation/publishing tests. Do not sanction participants,
replay failed jobs, change chat settings, enable guarded features or stress the
production primary to obtain an acceptance result.

Baseline source: `4d8ab77f1cadf6b7c563966dd4b9823bbd47411d`.
Preserve the pre-existing API agent-note edit and incident document.

## Evidence

- Baseline `npm run check:api`: 584 passing suites, 12,980 passing tests;
  23 suites / 161 tests skipped by environment gates. Typecheck/build and
  10 storage tests passed; one PostgreSQL storage race test was skipped.
- Early generator, contract-export and HTTP-boundary preflight passed.
- Read-only production observations around 20:35-20:39 UTC found both APIs ready,
  PostgreSQL/Redis available, normal mode, fresh Publisher heartbeat and all
  14 API roles on the expected image without duplicates. Public mini app assets
  returned 200; closed admin routes retained their access guards.
  Six capacity samples had queue lag 0-1.971 seconds, no failed readiness or
  queue-fence checks and no restart-counter increase. This is not an SLO window.
- The fixed queue audit found 1,770 retained FAILED webhook rows, no QUEUED rows
  and one current RECEIVED row. This is retained history, not current queue lag.
  A separate 30-minute monitor sample found nine FAILED events.
- The monitor reported two extra night-mode close-notice events in 21 sessions.
  Duplicate audit events do not by themselves prove duplicate remote messages.
- The OCR sandbox had 37 historical recycles and retention had one restart;
  these counters alone do not establish their cause. OCR readiness passed.
  A bounded retention-log inspection subsequently confirmed a prior V8
  `JavaScript heap out of memory` fatal error. No heap dump was collected and
  no causal attribution to a specific allocation path is established.
- Docker storage was about 90% full with about 30 GiB available. This is above
  the shared-image absolute floor but requires the normal percentage preflight.
  No shared Docker cleanup or policy bypass is authorized by these observations.
- Publication routing repeatedly reported `PUBLISHER_ACTOR_ACCESS_REQUIRED`;
  permissions must be restored by the appropriate entity administrator, never
  borrowed from a moderation bot.
- Official MAX DELETE and POST `/chats/{chatId}/members` documentation was
  retrieved read-only through the VPS because local DNS timed out. Both document
  a boolean `success` result. No real participant mutation was used for this audit.
- A bounded read of the reconciler snapshot at 20:56-20:57 UTC found all six
  moderation bots healthy/configured, zero missing update types and zero reported
  reconciliation errors. The snapshot was 50 seconds old; this does not prove
  that every individual webhook or user workflow succeeds.
- `npm audit --omit=dev --audit-level=high` found no high/critical advisories and
  two moderate vulnerable dependency entries (Fastify and its Nest adapter).
  `GHSA-w2qp-rph6-63g4` and `GHSA-3m5p-2c4r-xxw2` are patched by Fastify 5.12.1.
  The current HTTP bootstrap does not enable numeric `trustProxy`, and no
  Fastify root-primitive body-schema registration was found; handlers use the
  repository's explicit input validation. This lowers the observed exposure,
  not the need for a separately validated dependency update. Do not apply the
  audit CLI's suggested forced Nest major upgrade without compatibility review.

## Implementation Plan

| Priority | Finding                                                                                                                   | Change And Acceptance                                                                                                                                                                                                                                                            | Status                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| P1       | Member mutations accept malformed 2xx bodies as success; an unconfirmed unban can clear terminal BAN state.               | Require literal `success: true`; classify unconfirmed attempted mutations as ambiguous/unrecoverable, retain known explicit already-member recovery and prevent BAN-state cleanup without proof. Cover null, empty, array and non-boolean payloads for all three member actions. | Implemented; regression tests pass.                                                                      |
| P1       | An out-of-order Publisher authorization failure can overwrite a newer pause, allowing an intervening success to clear it. | Preserve the newest observation atomically in Redis, both with and without an operator pause. Execute the actual Lua scripts in isolated Redis tests, including equal-time success and post-failure recovery.                                                                    | Implemented; actual Redis regressions pass and CI requires them.                                         |
| P1       | Local action-health buffers grow indefinitely when only shared snapshots are read, or a worker never reads metrics.       | Prune each local buffer on append to the existing 180-second shared-storage horizon; remove expired prefixes in one splice rather than repeated shifts. Preserve all current 60-second consumers and scope/lane counters.                                                        | Implemented; no-reader and cached-reader regressions pass. This is not proof of the retention OOM cause. |
| P2       | Member-action `timeoutMs` bounds admission but is omitted from HTTP requests.                                             | Forward the existing normalized per-request timeout for BAN/KICK/UNBAN. Do not introduce automatic retry of ambiguous attempts or claim an end-to-end deadline.                                                                                                                  | Implemented; regression tests pass.                                                                      |
| P2       | Retained failures and repeated inaccessible publication/poll routes need operational triage.                              | Bounded classification by operation and age; verify exact access and durable receipts before any individually reviewed recovery. No queue purge or bulk retry.                                                                                                                   | Follow-up; causes not proven by this sample.                                                             |
| P2       | Night-mode duplicate events and historical process restarts need causal evidence.                                         | Correlate exact durable intent/ledger outcomes; compare restart deltas, bounded logs and queue trend across a busy period. Preserve OCR shadow and native isolation.                                                                                                             | Follow-up; not permission to resend notices or promote OCR.                                              |
| P2       | Disk warning reduces release headroom.                                                                                    | Inventory retained MAXIM images and manifests; prefer green exact-SHA CI preload or reviewed manifest-aware reclaim. Preserve sibling workloads and stateful services.                                                                                                           | Exact-SHA CI preload and reuse-only deploy completed without a build, cleanup or bypass.                 |

## Verification And Release Gates

1. Prove regressions fail on baseline, then pass on the corrected code.
2. Run complete API/typecheck/build, Prisma, static/refactor, docs and impact checks.
   Include the new real-Redis regression in CI's existing isolated Redis job.
3. Run contract/mini app/admin checks as the broad audit baseline; do not claim
   browser or live workflow acceptance from unit tests.
4. Submit only owned files through the staged wrapper. Require green exact-SHA
   `Required` and `Analyze JavaScript and TypeScript` checks.
5. Deploy only the shared API image to all 14 roles and its OCR auxiliary using
   the normal migration/readiness/disk/webhook-fence checks. No static rebuild,
   stateful-service recreation, ambiguous replay or emergency bypass.
6. Verify strict smokes and a bounded read-only post-release sample. Use the
   release manifest as deployment evidence. Record blockers and skipped checks
   honestly; an unperformed gate is not a successful result.

## Acceptance Boundaries

Live conversational, moderation and publication acceptance requires the designated
test chat/channel, confirmed entity types and uniquely marked agent-created
content. No load-test target or local Docker daemon was available at baseline.
Longer-term improvements should be measured: failed-event age/reason reporting,
per-operation latency and ambiguity rates, access-recovery notifications and
capacity trends. Do not increase concurrency or introduce a new stack without
evidence of the actual bottleneck.

## Local Results

- All 21 new member-response/timeout cases first failed on baseline.
  After correction, the transport/dispatch/ledger/Publisher group passed
  575 tests in five suites, including four actual-Redis cases.
- The actual Publisher Lua regression first reproduced two unsafe pause clears.
  Tests used an isolated, loopback-only Redis with persistence disabled;
  Ubuntu package bytes were verified against the local signed APT index digests.
  Production Redis was not used for testing.
- Both local-metrics retention regressions first failed on baseline;
  the corrected action-health/system-mode/queue-metrics group passed 31 tests.
  Retention is age-bounded, not an absolute event-count cap under an arbitrary
  burst. Local fallback snapshots beyond 180 seconds are not a supported product
  consumer; every current runtime caller requests 60 seconds.
- Contracts: 295 tests; mini app: 1,359 tests plus CSS/typecheck; Safety Desk:
  15 tests plus typecheck. Prisma validation/migration checks and 424 infra tests
  passed. These are automated checks, not live dialog/browser acceptance.
- Final staged validation passed: lint/refactor guards, 535 tooling tests, docs,
  API typecheck/build and 594 suites / 13,098 tests with local Redis enabled.
  Fourteen suites / 71 tests remained skipped, plus the PostgreSQL storage race;
  these external-service/native gates must be covered by exact-SHA CI.
- The fixture-only multi-bot route smoke passed 22 assertions. It makes no live
  MAX mutations and is not a substitute for live participant/publication tests.
- Runtime changes were submitted as `e4c5e38821249eeb8138c469b1959d616039ac1b`.
  Both required exact-SHA checks passed before any deployment.

## Delivery

- [CI run](https://github.com/GameclubPro/MAXIM/actions/runs/35654403610)
  passed the aggregate `Required` check, including the new real-Redis pause test,
  PostgreSQL races/migrations/storage, commercial benchmark, all images, native
  OCR smoke and frontend browser smokes.
- [CodeQL run](https://github.com/GameclubPro/MAXIM/actions/runs/35654403369)
  passed `Analyze JavaScript and TypeScript` and the high-severity alert gate.
- The normal preload wrapper verified the immutable API artifact checksum,
  exact revision/protection labels and disk capacity: 31,570,591,744 bytes free,
  729,716,736-byte archive, required 4 GiB reserve. The subsequent deploy reused
  the image; no local VPS build, Docker cleanup or emergency override occurred.
- The normal deploy wrapper synchronized the VPS to the exact source SHA,
  found no pending migrations, paused/fenced webhook work, recreated all
  14 API roles and the OCR auxiliary, verified exact image convergence and
  resumed the queues. PostgreSQL, Redis and static containers were not recreated.
- Release `release-20260921T211401Z-e4c5e3882124` was committed only after ingress
  and admin live/ready, public live, OCR isolation/languages/UDS raster/shadow
  smokes passed. Readiness briefly returned 503 after resumption, then recovered
  inside the normal deploy readiness window.
- The deploy emitted the existing missing `POSTGRES_PASSWORD`/legacy compatibility
  fallback warning. Before any separately planned PostgreSQL recreation, operators
  must securely verify/configure the current password. No password was printed,
  rotated or changed by this task.
- The initial post-release window, 21:17:12-21:19:12 UTC, contained eight complete
  capacity samples: queue lag 0-0.345 seconds, p50 0.055, p95 0.345, zero readiness,
  queue-fence or fleet-identity failures and zero restarts. All samples were still
  in the configured `stabilizing` recovery window, so the report correctly labels
  this interval degraded rather than uniformly healthy. A separate fresh webhook
  snapshot showed all six moderation bots healthy with recent incoming events.
- The follow-up 21:20:18-21:22:18 UTC window had eight complete samples, queue lag
  0-0.177 seconds and no readiness/fleet/fence failures or restarts. Its first six
  samples were still stabilizing; the final snapshot at 21:22:06 UTC was
  `normal/healthy` with zero queue lag. Both APIs, Publisher heartbeat and OCR
  readiness passed. Some 60-second action windows still contained 1-4 noncritical
  failures, so no claim of error-free live MAX operations is made.
- All local test/monitor processes were closed; the disposable local Redis and
  downloaded packages were removed. Existing user documentation was preserved.

## Remaining Work

1. Security maintenance: pin a reviewed Fastify 5.12.1-or-newer 5.x release,
   regenerate the lockfile normally and validate all images/HTTP consumers.
   Acceptance includes a clean production-dependency advisory scan and unchanged
   authentication/webhook input checks, not a forced framework major upgrade.
2. Retention memory: capture identifier-free heap/RSS and restart deltas through
   a real busy period. Reproduce sustained scheduling/deletion with a disposable
   database before changing the 512 MiB cap. The metrics-buffer fix has isolated
   regression evidence, not proof that it eliminates the observed OOM.
3. Failed deliveries: separate missing permissions, exact-message absence,
   transient transport, timeout quarantine and ambiguous dispatch. Recovery
   requires exact entity/intent evidence; missing author permissions need the
   entity administrator. Preserve all ambiguous send/member-action fences.
4. Night-mode signals: distinguish repeated audit writes from multiple confirmed
   remote IDs before proposing cleanup. No historical session catch-up or mass
   resend is part of this audit.
5. Capacity: the manifest-aware dry-run found no eligible old MAXIM images.
   CI preload is the current release option; longer-term disk growth requires
   retention/storage sizing, not host-wide Docker GC on this shared VPS.
