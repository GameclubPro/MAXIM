# Russian Profanity Filter Upgrade

Revision: 2026-09-15. Scope: API text detection and its existing pre-delete guard.
No chat settings, sanction thresholds, shared contracts, database schema, or UI changes.

## Diagnosis

The bounded production audit identified the art-studio announcement from the complaint at
15:42:27 UTC. Its decision was `CORE_MAT`, `core:yeb`, normalized variant `ебл`, with
`JOINED_FRAGMENTS` and `CHAR_SUBSTITUTION`, under `BALANCED` and `profanity-structured-v2`.
The visible excerpt itself passes the detector. The journal contains a truncated excerpt,
not the full original input, so the exact offending source span cannot be recovered from
that record alone. A synthetic continuation containing `группа 3-6 л.` reproduces the same
decision and both evidence tags. This is a verified failure mechanism, not a claim that the
unavailable continuation has been recovered.

The old numeric normalizer joins single digits and converts `3` to `е` and `6` to `б`.
The literal guard recognizes a single quantity, but not a range or contextual abbreviation
for years. It consequently treats age/volume notation as an obfuscated profanity root.
Conversely, repeated letters are reduced to two copies, so ordinary stretched Russian mat
such as `хуууй`, `бляяять`, and `ебааать` is missed.

Adjacent age labels also include `гр.` and `возр.`: their abbreviation period must not
erase the literal context of `гр. 3-6 л.`. Labels after the quantity, such as
`3-6 л., группа рисования`, are recognized without borrowing context across unrelated
sentences, line breaks, URLs, or emails.

The 13:30-16:55 UTC audit (executed before the window end) read 660 events representing 330
decisions: 40 built-in profanity decisions and 290 administrator stop-list decisions.
All built-in decisions had structured metadata. These are bounded operational counts,
not estimates of precision or recall; the audit samples only detected messages.

## Priorities And Implementation

| Priority | Work                                                                    | Acceptance                                                                                                                                       | Status                                                          |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| P0       | Recognize complete age/volume ranges before numeric letter substitution | Russian `л.`, `лет`, adjective forms, three dash styles, decimal volumes; ambiguous `л` requires local age/volume context or standalone notation | Implemented                                                     |
| P0       | Preserve independent word spans and protected literal boundaries        | An age, measurement, URL, email, or literal technical term cannot hide neighboring mat, including punctuation without spaces                     | Implemented                                                     |
| P0       | Keep ingestion and pre-delete decisions aligned                         | Queued old false positives are rejected by the existing guard; no historical sanctions are rewritten                                             | Implemented and regression-tested                               |
| P1       | Recognize stretched Russian mat and its transliteration                 | Bounded extra candidate with repeated letters collapsed, accepted only by existing productive core-root patterns                                 | Implemented                                                     |
| P1       | Make the release distinguishable in audit                               | `profanity-structured-v3` and `REPEATED_LETTERS` evidence; existing category metadata and settings retained                                      | Implemented                                                     |
| P1       | Expand regression gates                                                 | Safe announcements, adversarial neighbors, all sensitivities and both rollouts, existing corpus and hot-path budget                              | Implemented                                                     |
| P2       | Independently labeled Russian evaluation corpus                         | Temporal holdout, grouped duplicates, reviewed positives, negatives and ambiguous cases                                                          | Follow-up, not a prerequisite for the narrowly reproduced fixes |
| P2       | Review ambiguous insults, names and literal senses                      | Candidate-local context, category-specific metrics and paired hostile/literal controls before changing policy                                    | Follow-up                                                       |
| P2       | Improve complaint attribution                                           | Bounded source offsets and transformation metadata, without retaining additional raw messages or identifiers                                     | Follow-up requiring a privacy/retention review                  |

Repetition folding does not broaden the ambiguous-insult lexicon, use edit distance,
guess keyboard layouts, or invoke an external model in the moderation hot path. Original
candidates remain available for Russian doubled consonants. Numeric repetition is not folded.
Explicit chat stop words and their policy remain independent from automatic profanity exceptions.
`CORE_ONLY`, default `BALANCED`, `STRICT`, and the legacy policy switch retain their meanings;
`legacy` does not roll back these shared normalization safety fixes.

## Quality Gates

1. Every reported or reproduced clean message gets an allow fixture plus a nearby-mat control.
   Require zero regressions in the existing hand-reviewed and generated safe corpus.
2. Require all existing positive fixtures plus the new Russian repetition cases to pass.
   Exercise 1,350 age-range/policy combinations and their 1,350 explicit-mat neighbors.
3. Check public ingestion/side-effect-free guard parity and rejection of stale false-positive
   delete intents. Preserve current author identity, membership, settings and immunity checks.
4. Keep the existing 20,000-message benchmark at its unchanged default mean budget of 0.5 ms.
   Do not claim p95/p99 latency from a mean-time regression test.
5. Run `npm test --workspace @maxim/api -- profanity rule-engine.service.spec`, then
   `npm run check:api` and the staged-impact verification before delivery.

## Next Evaluation Stage

Build a reviewed Russian corpus from opt-in complaints and bounded, sanitized samples of both
hits and non-hits. Preserve spelling, punctuation, age notation and script mixing during
sanitization; recompute baseline decisions to identify sanitization-induced changes. Do not
assign ground-truth labels from the existing detector. Keep duplicates and all variants of
one source in the same split, and reserve a later time window for independent evaluation.

Stratify by clear mat, severe abuse, mild directed insults, names, clinical/literal language,
children's announcements, trade listings, technical terms, numbers, transliteration, mixed
scripts, inserted symbols, and repeated letters. Report per-category precision/recall with
sample sizes and uncertainty. A useful next promotion gate is zero confirmed benign deletions
in at least 3,000 independently adjudicated nonduplicate benign cases (roughly a 0.1% one-sided
95% upper bound for that sample), plus no loss on explicit-mat controls. This does not establish
population precision under a different message mix.

Do not expand fuzzy insult matching or automatically sanction ambiguous cases until that
evaluation demonstrates a benefit. Keep a small held-out complaint corpus permanently separate
from the synthetic templates used during development.

## Delivery And Observation

Use the normal staged-only commit/push helper and exact-SHA green `Required` and CodeQL gates.
Deploy only `api-shared`, including every API role and its OCR auxiliary; leave static services,
Postgres and Redis untouched. Prefer a reviewed immutable CI image when host build capacity is
insufficient. Preserve the queue fence and normal API/OCR smokes.

After release, inspect bounded audit slices with `moderation:audit-profanity` and default
text-free output, checking detector versions, family/evidence distributions, settings and
deletion counts. Review text only for an explicit complaint window. A falling deletion count
alone is not evidence of improved quality. Do not resurrect old deleted messages, clear queues,
reverse real-user sanctions, or mutate unrelated settings automatically.

For a confirmed release regression, use the manifest-aware immutable API rollback under the
normal shared-image and queue-fence guards. The environment's legacy switch changes category
policy; it is not a substitute for rolling back detector code.
