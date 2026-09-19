# Duplicate Miss Audit - 2026-09-19

## Scope And Complaint

Reviewed admission, text/navigation fingerprints, revisioned Redis history, deferred media
verification, ordering/queue retries, final delete/sanction authorization and administrator
diagnostics. The earlier September 14 and 16 fixes are present; this audit does not replace them.

The complaint was that duplicates sometimes remain. No affected chat, message pair or occurrence
time was supplied. Reproducing code defects establishes possible causes, not attribution of that
specific complaint. A concrete follow-up needs the chat, time/timezone, both messages, author
relationship, saved comparison mode, allowed repeats and comparison window. Use the authenticated
per-chat diagnostics first; do not reconstruct a conversation with unbounded production SQL.

The initial read-only production check at approximately 18:51 UTC found normal/healthy mode,
healthy database/Redis, successful ingress/admin readiness and sampled queue lag below one second.
The fixed audit catalog reported 84 duplicate deletions, six warnings and one mute in its complete
one-hour moderation-event sample. This is evidence of working enforcement, not a success rate.
The separate intent-status query hit its five-second statement timeout; no timeout was raised and
no missing intent results are presented as zero failures. The settings and daily event samples
hit their caps and are incomplete.

The message control was permanent revision 2, `full`, `all_enabled_chats`. The separate photo-only
control was missing. Saved photo options alone therefore do not activate photo-only/perceptual or
cross-author deletion. Full whole-message comparison can still verify exact photos independently.
Neither control, per-chat settings, historical jobs nor participants were changed for diagnosis.

## Confirmed Defects

1. High: after any failed or ambiguously acknowledged media queue add, the producer wrote `false`
   to the absorbing action-eligibility latch. An ordinary infrastructure failure thereby became
   a permanent prohibition. Retrying could detect the duplicate but could not delete it.
2. High: unavailable ordering registration was accepted as a successful enqueue with immutable
   `actionEligible: false`. Even if Redis recovered before processing, the job remained observation
   only and the webhook no longer requested a retry. This is distinct from a confirmed competing
   policy or immune author, which must continue to suppress enforcement.
3. Medium: unsupported binary signatures and media-kind mismatches were generic retryable errors.
   Because the first media candidate is verified lazily, one unsupported file could repeatedly
   block later valid messages sharing its candidate key. Exhausting a job did not advance that
   candidate, and the configured window can be long. Network failures still require retries;
   deterministic rejection of already downloaded bytes does not.

Five new unit assertions failed on the previous implementation before runtime edits. Regression
coverage includes real Redis/BullMQ flow failures before add, after a successful add with a lost
response, and during registration, plus a concurrent restrictive replay that must remain blocked.

## Implementation Plan

1. Completed: bounded production reads and code review, separating matching, delivery and product
   exclusions; reproduce defects before runtime edits.
2. Completed: unavailable registration throws the existing retryable ordering error before queue
   submission. A lost response re-announces the incoming eligibility instead of manufacturing a
   prohibition. The existing atomic AND latch retains every prior/concurrent `false`.
3. Completed: unsupported binary formats use the existing terminal error type. Baseline rejection
   can advance to current verified evidence; unsupported current messages still cannot authorize
   deletion. Transient download, governor, lease and database failures are unchanged.
4. Completed: targeted unit and real Redis/BullMQ regression coverage, including immutable job
   data, restrictive races, no duplicate action and no additional downloads on retry.
5. Completed: full API/static/docs checks and exact-SHA CI/CodeQL, followed by guarded deployment.
   The repair itself selects only shared API; the production manifest also required the static
   consumers of previously committed, unreleased contract changes. See Delivery below. No migration,
   new dependency, fleet scan, larger timeout or runtime-policy promotion was introduced.
6. Completed: release smokes and runtime-control recheck. Do not replay old failed jobs or reset
   action claims; the repair applies to normal new work. Post-release observations are below.

The steady-state path adds no network requests or Redis operations. Error recovery uses the
existing bounded registration call. Terminal format failures avoid repeated download/type checks
and allow subsequent verifiable content to progress.

## Preserved Boundaries

- Whole-message matching is per author and chat. Different authors are not whole-message repeats.
- Allowance zero removes occurrence two; allowance one deliberately permits occurrence two and
  removes occurrence three. The existing UI displays occurrence numbers, not the raw allowance.
- MESSAGE mode requires complete matching text/navigation/actions and verified media. A changed
  caption or different media can be a non-match. TEXT mode intentionally ignores media bytes.
- STANDARD is normalized exact matching; STRICT is bounded structured approximation, not semantic
  similarity. Punctuation, hidden destinations, numeric values and actions have safety constraints.
- Administrator/bot immunity, participant protection, manual release, current-content/settings
  checks and absolute deadlines remain mandatory. Unknown rights are not authority to delete.
- Missing media, unsupported attachments, split albums and resource-limit failures do not prove
  equality. This patch does not claim support for every file type or visually similar image.
- Out-of-order predecessors arriving after a later decision can still cause conservative misses.
  Older originals must not become punishable merely because later messages are already known.

## Prioritized Follow-Ups

1. Add identifier-free, bounded counters distinguishing candidate absence, non-match, unsupported
   evidence, queue deferral, expired deadline, missing capability and terminal guard rejection.
   Current intent diagnostics cannot explain a message that never reached intent creation.
2. Profile the fixed intent audit's indexed plan on representative local PostgreSQL data. Its
   timeout is a diagnostic limitation, not justification for a larger primary-database scan.
3. Measure per-chat media queue waiting and late-event frequency before changing ordering. Consider
   per-author scheduling only with proof of shared action-claim safety, replay behavior and bounded
   retention. Do not add a sleep to every text message to compensate for unmeasured disorder.
4. Broader file support, source-URL renewal for non-photo media, split-album assembly and perceptual
   photo activation need separate evidence/admission designs and resource budgets. Do not equate
   platform IDs, filenames or URLs with content hashes to increase detection rates.
5. Review approximate matching's bounded fingerprint selection and photo-counter ladder semantics
   with representative series fixtures before widening matching or changing sanction thresholds.

These follow-ups are not silently enabled by a reliability repair. They require measurements or
explicit product decisions; the implemented fixes retain existing authority and resource limits.

## Validation

- Focused local Redis run: 33 suites and 484 tests passed. Two PostgreSQL-dependent tests were
  skipped in that run; PostgreSQL races subsequently passed in exact-SHA CI.
- Full API validation: typecheck, build, 577 suites and 12,893 tests passed. The standard run
  skipped 23 environment-dependent suites/152 tests; it is not a claim that those ran locally.
- Repository lint, refactor guards, documentation checks and 534 tooling tests passed.
- Exact-SHA CI and CodeQL passed for `bcb256b694bd4874b1e6fff5a0e046bd73ba8562`. Its mandatory
  duplicate/interval Redis lane passed all 14 suites/165 tests. All three image builds, PostgreSQL
  race tests, native OCR smoke, benchmark and frontend checks also passed.
- Production dependency audit passed its required high-severity threshold. The preceding main
  CI failure was an npm registry maintenance 503, not a reason to bypass the audit or force a
  breaking dependency upgrade. The audit still reports two moderate Fastify-related advisories.

## Delivery

Runtime commit: `bcb256b694bd4874b1e6fff5a0e046bd73ba8562`.
Release: `release-20260919T192804Z-bcb256b694bd`.

The first attempt stopped before runtime mutation on a VPS-to-GitHub port-22 timeout after the
deploy-tooling re-exec. The documented caller-only `MAXIM_DEPLOY_GIT_SSH_PORT=443` transport
completed synchronization without changing persistent SSH configuration.

The next preflight detected unreleased contract impact in the existing component manifests and
therefore selected both active static consumers as well as shared API. Its disk-percentage guard
refused on-host builds before changing containers. All three green exact-SHA images were then
preloaded through checksum, image-identity and archive-plus-reserve validation. Normal deploy
reused them; no disk guard was weakened, no host-wide cleanup was run and no fallback build ran.

All 13 API roles, the OCR sandbox, `miniapp-major-static` and `admin-static` were updated. The
static changes came from earlier commits already on main, not new UI edits in this repair.
PostgreSQL and Redis were not recreated; no migration was pending. The normal queue fence covered
the mixed-version interval. Readiness briefly returned 503 while the accumulated queue drained,
then ingress/admin live/ready, public live, canonical `/app/`, Safety Desk and isolated OCR/UDS
smokes passed before the manifest was committed. No participant was used for a live sanction test.

## Post-Release Observation

The completed 19:32:04Z-19:37:04Z capacity window contains 20 samples with complete coverage.
Readiness, queue metrics/fence and exact API fleet topology had no failing or unknown samples.
No restarts were observed. Sampled oldest-queue lag was 0-1.686 seconds (p95 0.736); these are
queue-age samples, not request latencies. Eighteen samples were still in automatic stabilization,
so the entire window is not described as normal. The last sample was `normal / healthy` with
zero queue lag; the separate 19:37:40Z health check confirmed the same state and healthy DB/Redis.

Message runtime control remained permanent `full`, revision 2, `all_enabled_chats`. The standalone
photo control remained missing. A later fixed-catalog audit completed within its original limits:
its one-hour event window contained 53 duplicate deletions, and its bounded intent sample included
38 successful, 41 retryable, 32 waiting-capability, five expired and five terminal duplicate
intents. Several status samples were saturated and the windows overlap the previous image. These
figures neither measure improvement nor prove that every missed deletion is fixed. Missing rights,
temporary MAX failures, unsupported evidence and configured exclusions still require case-specific
diagnosis; no historical jobs, author protections or action claims were reset.

The disposable local Redis and downloaded test binaries were removed. The read-only monitor
finished normally and removed its transient full log, retaining only its ordinary privacy-safe
capacity archive. Pre-existing user changes in agent notes and an unrelated incident document
were preserved and excluded from both commits.
