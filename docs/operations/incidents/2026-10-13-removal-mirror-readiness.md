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
its retained-history native PostgreSQL plan. Acceptance additionally requires
exact-SHA Required/CodeQL, all
shared-image roles, strict readiness, closed fresh cohorts, separate MAX outcomes
and a continuous 15-minute sub-10-second lag observation. Deployment evidence is
recorded below when completed; passing unit tests alone does not establish recovery.
