# Duplicate source and publication audit, 29 October 2026

The request was to investigate reported identical-advertisement misses and production delays.
No exact message pair or complaint window was supplied for this audit. The earlier test-chat
complaint involved stale administrator immunity; that does not establish the cause of this
new complaint.

At 05:24 UTC the installed shared API was `798075fad3b7cb4a70c17d75afd46dd2d544a3a8`,
image `sha256:4cce4f689a5357c4477e2fb7d8ecaaab22deaf43179290a2d65beefbe24abc3b`.
All fourteen API roles and both native auxiliaries were running. Fresh readiness had healthy
stores and operational lag below one second. A complete five-second receipt cohort contained
69 processed events, 19 ingress duplicates and no failed, waiting or quarantined rows;
processed-only p95 was 979 ms. This is a bounded observation, not fleet-wide feature acceptance.

The bounded duplicate audit found active moderation and some confirmed successful delete
intents. Its settings and terminal-intent samples were capped. Runtime diagnostics separately
showed media ordering/governor waits and unavailable fresh source reads; these are not detector
non-matches or permission to skip dispatch guards. Existing uncertain historical owners remain
subject to their separately approved recovery scope.

## Reproduced corrections

| Scenario                                                   | Defect                                                                                                                    | Required result                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Incoming candidate inside an array or a literal dotted key | The ingress parser selected a valid message, but duplicate extraction reinterpreted its diagnostic path and lost the node | Compare that same complete message                                             |
| Fresh exact-message response with a `content` body         | The direct row was mistaken for a wrapper and considered missing                                                          | Verify the returned row against the binding                                    |
| Edit in an event/data envelope                             | Publication lookup only read `raw.message`, so comparison was rejected before enforcement                                 | Preserve the selected message's publication date and enforce a verified repeat |
| Delayed created event in an envelope                       | Event arrival time substituted for the original publication clock                                                         | Allow a new announcement once the original fixed window has elapsed            |

The initial regressions produced ten failures, including native Redis full-flow misses and
an incorrect deletion beyond the original's fixed window. The correction preserves the
separate ingress identity/deadline projection and moves positive history to v4 while retaining
v3 removal/reset evidence. The [rollout contract](../runbooks/message-duplicate-rollout.md#source-selection-and-publication-clocks)
describes this transition and its temporary history warm-up.

## Validation and remaining evidence

Focused coverage includes source extraction, publication clocks, full text/photo Redis flows,
history replay/reset/removal, old-fence transition, unchanged semantic identity/deadlines and
rollback reader rejection. Native SQL cases must also cover final qualification, action claims,
dispatch and mirrored webhook execution before release. Mocks do not prove those boundaries.

Final transition review reproduced stale/conflicting v3 lifecycle admission into fresh positive
history. The upgrade now retains negative revision evidence and unknown introduction times,
including preliminary lifecycle observations and exact-source invalidation. Later proven material
changes can establish a new original at their observed edit time. Focused history, full-flow and
offline replay checks passed 666 cases with real stores; rollback rejection checks passed 239.

Delivery requires the normal staged aggregate, exact-SHA CI, all-role deployment and fresh
production observations. A green local regression does not claim those later gates passed.
Specific complaint attribution still needs the message pair, chat and time. Aggregate activity
does not establish recall or false-deletion rates; independent labelled corpus evaluation
remains separate. Media delays must be attributed to measured admission/source/host pressure
before changing concurrency or enabling the experimental shared media admission policy.
