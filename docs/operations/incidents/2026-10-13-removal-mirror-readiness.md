# Readiness 503 from a deferred removal mirror

## Baseline and cause

At 2026-10-12 21:39:02 UTC (13 October 00:39:02 Moscow), REG.RU ingress readiness
returned 503 with healthy PostgreSQL and Redis. Active API source was
`41430f93c0f7fe4de1794781849ea5b1945c4183`, release
`release-20261012T174413Z-41430f93c0f7`. The permissions-model commit
`6e4000147876d5547f44273021f8a83e17953896` had passed exact-SHA CI but was not deployed.

The oldest RECEIVED receipt was created at 18:53:05.032 UTC; raw and operational lag
were 9,957.367 seconds. QUEUED lag was zero. The simultaneous 60-second action window
reported 1,911 actions, 1,905 successes and six failures. This proves continuing
activity, not complete delivery or recovery. A bounded queue sample contained 36
RECEIVED rows and no QUEUED rows; the historical FAILED sample reached its 2,000-row
cap and must not be interpreted as fresh failures. Earlier bounded samples had two
persistently deferred receipts. Only the oldest was individually classified.

Fixed catalog `webhook-source-proof` at 21:40:18.833 UTC established:

- The head was a `message_removed` copy with zero enqueue attempts, no queued time,
  no execution deadline, and a repeatedly advancing preparation retry.
- Its different canonical owner, received at 18:53:04.078 UTC, was FAILED with the
  exact pending `LEGACY_EXECUTION_UNVERIFIED` marker and no scheduled retry.
- Their stored semantic identities matched. The shared enforced claim was PENDING,
  unprepared, unstarted, incomplete and without a lease; the mirror had no linked claim.
- There was no ordered predecessor because removal notifications are nonordered.
  Lack of observed DELETE ledger rows did not prove absence of effects.

A reviewed scalar-only extension to the same catalog, sampled at 21:43:51.956 UTC,
found a genuine raw object with a direct numeric MAX timestamp **4 ms ahead of the
owner receipt**. `hasNewOriginalSource` required `sourceAt <= receiptAt`, so this
small clock difference alone rejected fresh-source proof. It installed the legacy
hold. Copies repeated preparation every five seconds; the existing propagation
helper covered `user_removed` only. Ordered dependency quarantine covered created
and edited messages, not this nonordered notification. The active copy therefore
kept fleet readiness red despite independent traffic progressing.

The extended read-only catalog ran from hash-verified temporary script/helper
siblings, removed on exit. Its restricted grants, shared lock, statement/lock/wall
limits and read-only transaction were unchanged. Plain EXPLAIN was reviewed before
the report: all seven application-table probes used the existing exact indexes;
no broad query, live EXPLAIN ANALYZE, new grant or raw payload export was used.

## Correction and safety

New-source classification permits at most 1,000 ms of clock lead against the earlier
of receipt and current time. The source must still be after the successful migration
cutoff; original message creation checks, exact semantic identity, enforced modern
claim and indexed older-mirror exclusion remain required. No timestamp, execution
deadline or cutoff is rewritten. Larger, missing, invalid and historical source
proof remains rejected. Existing legacy quarantine is explicitly sticky, even when
the new clock check would accept its source.

The existing locked propagation helper now covers both nonordered removal types.
It copies only the pending no-replay marker to a pristine, never-enqueued mirror of
that exact unprepared owner. Claim-before-receipt locks, disposition/independent-claim
checks, original payloads, source owner and all effect evidence remain intact. A
stale outbox deferral CAS cannot revive the held copy. This stops active scheduling;
it is neither PROCESSED, DUPLICATE, cancellation nor proof of a remote action.

Agent instructions now require autonomous investigation and safe correction of
readiness, smoke, CI and deploy blockers inside the authorized task. Strict release
gates and uncertain-effect/destructive-recovery boundaries remain mandatory.

## Validation and rollout

Before the runtime correction, the native removal regression failed for message
removal propagation and competing propagation (two failures, 22 passes). Clock and
installed-hold regressions separately reproduced three failures. After correction,
six focused native-store suites passed all 221 tests. The final installed-hold fixture
also passed all 24 removal cases; the diagnostic suite passed all 12 tests including
its retained-history native PostgreSQL plan. The full API run passed 748 suites and
19,115 tests; its 2,185 store-dependent skips were not counted as native coverage.
The exact-SHA native CI lane separately passed 75 suites and 1,347 tests, with
activation, report, rollup and retention checks also passing. Contracts, API,
Mini App/browser, Safety Desk, infrastructure, builds and CodeQL were green.

Runtime source `4aa48ce88d5b3dd1f7ad3bafce398df6b31d60c5` includes permissions
commit `6e4000147876d5547f44273021f8a83e17953896`. Exact-SHA CI run `38314646959`
and CodeQL run `38314647075` passed before immutable API, Mini App and Safety Desk
images were preloaded. The guarded automatic deploy recorded
`release-20261012T223430Z-4aa48ce88d5b` at **22:36:59.317 UTC** (13 October
01:36:59.317 Moscow), with every component on that source SHA and no emergency bypass.
All 14 API roles and both static components were updated; native auxiliary isolation
and execution smokes also passed. Migrations `20261012230000_add_personal_admin_history`
and `20261012230100_index_personal_admin_history` were applied.

Immediately before rollout, the bounded queue audit still found two deferred
RECEIVED copies with zero attempts and oldest age 13,267 seconds; QUEUED was empty.
Immediately after rollout both active sets were empty. Strict ingress/admin readiness,
public live, Mini App, Safety Desk and native sandbox smokes passed before committing
the manifest. PostgreSQL and Redis retained their earlier container/start identities
and zero restart counts; neither stateful service was recreated.

## Sustained production observation

Acceptance requires homogeneous images, released queues, healthy dependencies,
closed fresh cohorts, separate MAX outcomes and at least 15 continuous minutes of
sub-10-second lag. The observation below uses aggregate-only 15-second capacity
samples; no raw event identities or payloads are retained. An initial log-inclusive
collector was stopped locally to avoid retaining identifiers; its raw logs were
removed and its aggregate capacity samples preserved separately. It is not combined
with the fresh acceptance clock that started at **22:40:03.901 UTC**.

The collector completed **65 valid samples through 22:56:03.900 UTC**: 959.999 seconds
at a nominal 15-second interval, maximum sample spacing 17.436 seconds, with no missing
or unavailable probes. Maximum operational lag was **0.724 seconds**. Both readiness
endpoints returned 200 throughout; all 14 roles retained the exact image, with zero
duplicates, unexpected API containers or restarts. The queue fence remained released
and unowned. Recovery hysteresis settled to `normal/healthy` at 22:42:18.900 UTC.

Three nonempty, complete, untruncated closed cohorts were sampled independently:

| Receipt-created window (UTC) | Observed at (UTC) | PROCESSED | DUPLICATE | Processed-only p95 |
| ---------------------------- | ----------------- | --------: | --------: | -----------------: |
| 22:39:21.022–22:39:51.022    | 22:40:21.022      |        65 |         7 |           535.4 ms |
| 22:42:31.301–22:43:01.301    | 22:43:31.301      |        69 |        12 |           405.4 ms |
| 22:52:10.215–22:52:40.215    | 22:53:10.215      |       124 |        27 |          705.75 ms |

Every other status, pending count and invalid-clock count was zero in these samples.
The per-status cap was 512. These are separate sampled cohorts, not a census of all
traffic or proof of remote effects. Historical pending no-replay holds were preserved;
no queues were cleared, effects replayed, or held events fabricated as successful.

Separate overlapping 60-second action windows contained 1,470–1,919 attempts,
1,470–1,893 successes, 0–32 failures and 0–1 critical failures; the maximum error rate
was 1.7401%. These ranges must not be summed. A bounded privacy-safe classification of
coalesced action-failure logs in 22:40:00–22:56:10 found 49 HTTP 404 markers and two
markers without HTTP status; unknown codes remain unclassified. No service reached
the 1,001-line cap; two services each had one unparsed line. This log sample cannot
attribute every action failure. It does not invalidate measured queue/readiness recovery
or establish error-free MAX delivery.

After this rollout, the owner reported that requiring a fresh human proof before each
home card made a 100+ entity catalog rebuild one card at a time on every launch. The
follow-up changes home to persisted navigation and moves human checks to selected
settings; it does not reinstate fleet scans or expire bot proof. Its rollout is a
separate runtime boundary from the recovery evidence above.
