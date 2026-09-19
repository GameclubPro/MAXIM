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
5. Release gate: run the full API/static/docs checks and exact-SHA CI/CodeQL; deploy only the shared
   API component with the normal queue fence and all role/OCR smokes. No migration, contract/UI
   change, new dependency, fleet scan, larger timeout or runtime-policy promotion is needed.
6. Release verification: confirm readiness, unchanged runtime controls and bounded observations.
   Do not replay old failed jobs or reset action claims; the repair applies to normal new work.

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
