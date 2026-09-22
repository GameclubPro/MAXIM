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
   reuse and case-sensitive link matching. Extend the existing unit and real-Redis flow tests.
2. Completed: hash native-size decoded pixels, isolate cached proofs by message/revision/source,
   and preserve navigation identity in value matching. Version changed evidence so old cached
   hashes and queued bindings cannot authorize deletion under the new policy.
3. In progress: verify retries, edits, independent albums, author scope, allowed repeats, final
   guards and resource limits. Run full API and staged impact validation.
4. Pending: exact-SHA CI/CodeQL, guarded shared-API-only release, strict smokes and a bounded
   read-only observation. No migration or static deployment is anticipated.

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

A local maximum-size synthetic 40-million-pixel PNG took 140 ms to fingerprint; peak RSS of the
isolated process including fixture creation was 265 MiB. This is a resource smoke, not a real-world
latency benchmark or proof of worst-case decoder performance.

The completed 12:35:34Z-12:37:34Z pre-release window had eight samples with complete coverage,
healthy readiness/queue/fleet checks and zero restart increases. Oldest-queue lag was
0.227-1.256 seconds. All samples were in automatic stabilization, so the window is not labelled
normal. The read-only monitor completed and removed its transient full log.

## Safety And Remaining Questions

- STANDARD compares text/navigation; CUSTOM can deliberately match just a phone or link.
  IMAGE ignores captions, and CHAT scope can match another author's earlier image. These
  settings can surprise users without an algorithmic false match; do not silently rewrite them.
- Image equality must retain dimensions and alpha and must not downsample away a changed
  detail. Keep existing download, pixel, album, concurrency and retry budgets.
- A platform photo ID is a locator, not independent proof of equal content across messages.
- Identify the reported incident only with the affected chat, message/time and saved rule
  evidence. Avoid unbounded production content searches or exposing personal data in reports.
