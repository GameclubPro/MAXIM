# Duplicate False-Positive Audit - 2026-09-22

## Scope And Attribution

Investigate unwanted duplicate deletions across text fingerprints, image evidence, event
replays/edits, history windows and final dispatch guards. The supplied screenshot contains a
complaint and part of an advertisement, but no chat/message reference, date or bot deletion
notice. Reproducing a defect does not attribute that particular complaint to it.

Preserve administrator-selected comparison modes, author scope, allowed repeats and sanctions.
Do not replay old jobs, clear claims, change chat settings or mutate participant messages.

## Plan

1. Completed: reproduce evidence loss in resized image hashes, cross-message photo-ID cache
   reuse, case-sensitive links and STRICT numeric stripping. Extend unit and real-Redis tests.
2. Completed: hash native-size decoded pixels, isolate cached proofs by message/revision/source,
   and preserve navigation/numeric identity in text matching. Version changed evidence so old cached
   hashes and queued bindings cannot authorize deletion under the new policy.
3. Completed: verify retries, edits, independent albums, author scope, allowed repeats, final
   guards and resource limits. Run full API and staged impact validation.
4. Completed: exact-SHA CI/CodeQL, guarded shared-API-only release, strict smokes and a bounded
   read-only observation. No migration or static deployment was needed.

## Initial Operational Evidence

The bounded health read found healthy PostgreSQL/Redis and no queue backlog, with automatic
MAX-API degradation (3.63% reported action errors). No live mutation test was attempted.
The fixed duplicate audit returned saturated settings/event samples; its next statement hit
the configured statement timeout. These are incomplete lower bounds, not a fleet success rate.
Legacy photo-toggle aggregates do not describe the current IMAGE path's effective activation.

## Reproduced Defects And Fixes

1. High: exact image hashing downsampled to 512x512 and flattened transparency against white.
   A changed native pixel, different dimensions and alpha could yield the identical hash.
   Hash full native RGBA with dimensions and EXIF orientation instead. Reject non-8-bit input
   instead of silently quantizing it. Existing pixel/album/concurrency bounds remain.
2. High: the inner photo cache was global by platform photo ID. A new message/chat/revision
   or changed URL could reuse an unrelated fingerprint without verifying its bytes. Bind cache
   identity to the message, revision and source; exact same-source retries retain cache reuse.
3. High in CUSTOM: message text was lowercased before extracting link values, merging distinct
   case-sensitive paths, query values and fragments. Near matching also erased plain navigation
   identity. Preserve raw text for extraction and bind non-ignored navigation in near fingerprints.
   Explicit STRICT link/phone ignoring and CUSTOM value-only matching remain product choices.
4. High in STRICT: the phone-stripping regex erased ordinary dates, long prices and numeric
   ranges without checking that they were phones. It also removed the preceding boundary
   character, merging distinct adjacent labels. Four regressions reproduced false WARN decisions.
   Reuse the existing validated phone classifier for stripping and preserve the boundary;
   add a real-Redis changed-date/actual-repeat regression. Advance the text evidence version again.

Six image/cache regressions failed before their fixes; four real-Redis link/near regressions
failed with the old text path. The first focused fixed run passed 17 suites / 272 tests, including
independent reused-ID images, actual later duplicates, lossless encoding, retries, scope,
configured escalation and rejection of queued thumbnail-era evidence. This is not incident
attribution or a claim of exhaustive correctness.

The algorithm version invalidates old proof caches and guarded bindings without deleting them.
The text policy digest and fallback fingerprint namespace also advance. New observations warm
the corrected history; settings and thresholds remain unchanged. Source hashing uses one bounded
native-size buffer at a time; it does not retain every decoded album image in memory.

## Validation Progress

The first broad local check passed API typecheck, build and 594 suites / 13,112 tests. Fourteen
environment-dependent suites / 71 tests were skipped. The separate retention-storage lane passed
10 checks with its PostgreSQL race skipped. Repository lint/refactor guards and all 535 tooling
tests passed, as did documentation checks and preflight. Final staged verification also covers
the subsequent fallback-detector URL regression tests and hot-path early return.

The first staged commit was `c41aaa57db79c079850d259f28955ac37d693de9` (13,115 API tests).
Before any deployment, the additional STRICT numeric-evidence defect above was reproduced and
added to the release. Its final staged validation and exact-SHA CI must supersede that first commit.

The final runtime commit is `333fa659f3aba398082fe3cf0e8ce53654fbc743`. Its focused numeric/message
run passed 15 suites / 247 tests. Staged verification passed all 594 API suites / 13,129 tests,
typecheck, build, 535 tooling tests, lint, refactor guards, documentation and preflight. Local
environment-dependent skips remain the same; PostgreSQL integration is delegated to exact-SHA CI.

A local maximum-size synthetic 40-million-pixel PNG took 140 ms to fingerprint; peak RSS of the
isolated process including fixture creation was 265 MiB. This is a resource smoke, not a real-world
latency benchmark or proof of worst-case decoder performance.
Two successive 40-million-pixel images under the default 80-million-pixel album limit took
300 ms with peak RSS 414 MiB in a separate synthetic process. The third image was rejected
with `album_decode_budget_exceeded`; no configured resource ceiling was raised.

The completed 12:35:34Z-12:37:34Z pre-release window had eight samples with complete coverage,
healthy readiness/queue/fleet checks and zero restart increases. Oldest-queue lag was
0.227-1.256 seconds. All samples were in automatic stabilization, so the window is not labelled
normal. The read-only monitor completed and removed its transient full log.

## Delivery And Post-Release Observation

Release: `release-20260922T131540Z-333fa659f3ab`, exact runtime source
`333fa659f3aba398082fe3cf0e8ce53654fbc743`. Required and CodeQL passed for this SHA, including
PostgreSQL races, the separate Redis lane (17 suites / 194 tests), all image builds and native OCR
smokes. The default API CI lane passed 584 suites / 13,029 tests; its environment-dependent tests
run in separate lanes, so those totals must not be added together as distinct tests.

The plan selected only `api-shared`. The verified CI image was preloaded through checksum,
protected image identity and archive-plus-reserve capacity checks because the host disk was
92% used. Deployment reused it without building, weakening a disk guard or host-wide cleanup.
All 14 shared API roles and the isolated OCR sandbox were updated. Both static components,
PostgreSQL and Redis were not recreated; Prisma reported no pending migrations.

The normal queue fence protected active/detached work and the mixed-version interval. Readiness
temporarily returned 503 while the accumulated queue drained: the recorded peak age was 249
seconds, then 95 seconds in a bounded readiness read. No readiness timeout was bypassed or
extended. Local ingress/admin live/ready, public live, OCR isolation/UDS/shadow and internal OCR
readiness smokes passed before the release manifest was committed. Message authority remains
permanent full, revision 2, all-enabled-chats; no runtime control or participant setting changed.

The completed 13:21:58Z-13:26:58Z observation has 20 samples and complete coverage. Readiness,
queue metrics/fence and exact API topology had no failing or unknown samples; all roles had zero
restarts. Sampled oldest-queue lag was 0-16.814 seconds, median 0.489 and p95 8.796, with one
warning sample and no critical samples. These describe sampled queue age, not request latency.
The whole window remains degraded/stabilizing, not uniformly healthy. The 13:28:31Z follow-up
confirmed healthy DB/Redis and readiness, lag 0.801-1.304 seconds, still in automatic stabilization.

Host load remained elevated (load/core 1.176-1.57), with existing disk/swap warnings. A single
Docker sample showed background moderation at 55.98% of one CPU and 1.208 GiB, enqueue at 28.67%
and 459 MiB, and action at 49.50% and 508 MiB. These are point samples without a corresponding
pre-release per-role baseline; do not claim that the new algorithm caused or resolved host load.

A bounded background/action log sample contained three valid diagnostic summaries, 115 completed
worker attempts, 75 baseline verifications and one terminal attempt. These are overlapping attempt
counts, not confirmed deletions or a success rate. The monitor removed its transient full logs;
the disposable loopback Redis and downloaded local test binaries were removed. No participant
message was created/deleted for a live smoke and no historical sanctions or claims were replayed.

## Safety And Remaining Questions

- STANDARD compares text/navigation; CUSTOM can deliberately match just a phone or link.
  IMAGE ignores captions, and CHAT scope can match another author's earlier image. These
  settings can surprise users without an algorithmic false match; do not silently rewrite them.
- Image equality must retain dimensions and alpha and must not downsample away a changed
  detail. Keep existing download, pixel, album, concurrency and retry budgets.
- A platform photo ID is a locator, not independent proof of equal content across messages.
- Identify the reported incident only with the affected chat, message/time and saved rule
  evidence. Avoid unbounded production content searches or exposing personal data in reports.
- Current administrator diagnostics describe bounded dispatch outcomes, not a linked original
  message explaining equality. A future evidence view needs an explicit bounded retention/access
  contract; adding raw contents or broad historical queries to diagnostics is not an acceptable fix.
- Approximate administrator-selected matching remains heuristic, not semantic understanding.
  Unsupported high-bit-depth images, partial albums and unverified media remain fail-open.
