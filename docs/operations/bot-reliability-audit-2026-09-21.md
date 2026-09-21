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

## Implementation Plan

| Priority | Finding                                                                                                                   | Change And Acceptance                                                                                                                                                                                                                                                            | Status                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| P1       | Member mutations accept malformed 2xx bodies as success; an unconfirmed unban can clear terminal BAN state.               | Require literal `success: true`; classify unconfirmed attempted mutations as ambiguous/unrecoverable, retain known explicit already-member recovery and prevent BAN-state cleanup without proof. Cover null, empty, array and non-boolean payloads for all three member actions. | Implemented; regression tests pass.                                                                      |
| P1       | An out-of-order Publisher authorization failure can overwrite a newer pause, allowing an intervening success to clear it. | Preserve the newest observation atomically in Redis, both with and without an operator pause. Execute the actual Lua scripts in isolated Redis tests, including equal-time success and post-failure recovery.                                                                    | Implemented; actual Redis regressions pass and CI requires them.                                         |
| P1       | Local action-health buffers grow indefinitely when only shared snapshots are read, or a worker never reads metrics.       | Prune each local buffer on append to the existing 180-second shared-storage horizon; remove expired prefixes in one splice rather than repeated shifts. Preserve all current 60-second consumers and scope/lane counters.                                                        | Implemented; no-reader and cached-reader regressions pass. This is not proof of the retention OOM cause. |
| P2       | Member-action `timeoutMs` bounds admission but is omitted from HTTP requests.                                             | Forward the existing normalized per-request timeout for BAN/KICK/UNBAN. Do not introduce automatic retry of ambiguous attempts or claim an end-to-end deadline.                                                                                                                  | Implemented; regression tests pass.                                                                      |
| P2       | Retained failures and repeated inaccessible publication/poll routes need operational triage.                              | Bounded classification by operation and age; verify exact access and durable receipts before any individually reviewed recovery. No queue purge or bulk retry.                                                                                                                   | Follow-up; causes not proven by this sample.                                                             |
| P2       | Night-mode duplicate events and historical process restarts need causal evidence.                                         | Correlate exact durable intent/ledger outcomes; compare restart deltas, bounded logs and queue trend across a busy period. Preserve OCR shadow and native isolation.                                                                                                             | Follow-up; not permission to resend notices or promote OCR.                                              |
| P2       | Disk warning reduces release headroom.                                                                                    | Inventory retained MAXIM images and manifests; prefer green exact-SHA CI preload or reviewed manifest-aware reclaim. Preserve sibling workloads and stateful services.                                                                                                           | Release preflight pending.                                                                               |

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
- Final staged validation, exact-SHA CI and production release remain gates;
  their completion must be recorded after the actual commands finish.
