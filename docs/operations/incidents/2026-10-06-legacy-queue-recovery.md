# Legacy queue recovery, 6 October 2026

This incident remains open. Times below are UTC. A running fleet, a completed finite
recovery scope and an empty actionable queue are separate acceptance conditions.

## Observed failure and corrections

Original pre-migration events remain ordering barriers in multiple chats. A bounded
128-receipt window exposed 32 eligible historical heads; it was truncated and was not
a fleet census. Unknown historical effects cannot be classified as successful or
replayed merely to remove the barrier.

On `30a1e1a61cbf076f1e20455cee6907423ada6c31`, two previously recovered scopes remained
complete. Another four-chat scope completed at `2026-10-06T09:31:52.243Z` after the
initial installation and two official reconciliations. Installation was not repeated.
Permanent protections and positive cursor completion were proved before restarting
the captured fleet and releasing all 24 webhook queues. The first two attempts
reported only `protocol_proof_failed`; their precise failure cause was unavailable.
A bounded read-only observation captured one completed 543-receipt cursor. These
dispositions abandon historical effects and do not report executed moderation.

A further one-chat scope completed at `2026-10-06T10:31:41.308Z` on `a2dcbf51`,
after installation and one official reconciliation. Its reviewed cold inventory
contained 4,121 rows with no issues. Both completions reported `fleetReady: false`.

At `2026-10-06T09:32:26Z`, both ingress and admin reported healthy PostgreSQL/Redis
but HTTP 503 for automatic queue backlog, with oldest received lag about 51,670
seconds. The completed scope did not establish fleet recovery.

Code review found that outbox selection awaited every active operation in a batch.
Consequently a slow preparation or queue handoff delayed selection for independent
chats even while other capacity was available. Release
`a2dcbf51d92bb7c0c16b0fd67f7a32469f142e9a` carries active work across polls under one
bounded concurrency limit and same-chat/event exclusion, with owned shutdown drain.
It preserves ordering and execution authority. Unit tests and a real PostgreSQL/Redis
fixture verify that fresh independent receipts advance while an earlier operation
remains unfinished. Existing per-bot preparation limits remain.

The same release corrects recovery validation for incoming video metadata:
`payload.id` is passive opaque int64 metadata and `thumbnail` may be a strict object
containing its URL. Original message identity, command denials, source proof and
permanent holds remain required. Native store tests cover installation and receipt
materialization with this shape. The release was submitted for an explicitly
authorized emergency production rollout after focused validation; exact-SHA CI
and runtime acceptance must be recorded separately.

The exact `a2dcbf51` CI PostgreSQL lane refused a materialization-preview plan.
Local reproduction with fresh statistics showed a bitmap scan on a status index
and a sort instead of the required ordered chat index. The correction sets
transaction-local planner controls in the metered preview and retains strict index,
predicate and plan bounds. Native checks include adverse planner costs, real scan
refusal, missing-index refusal and restoration of settings after the transaction.

The next recovery correction compares independently validated direct-video mirrors
without their bot-specific URL/token transport fields. A production structural
audit found exactly two mirrors with equal message, author, text, clocks, media ID
and preview, differing only in those two fields. Original receipt digests remain
frozen in the inventory. Cursor checkpoint updates are also batched atomically per
page; a 302-receipt native fixture used nine updates instead of 303, with explicit
blocked-prefix and rollback coverage. This fixture is not a production speed claim.

At `2026-10-06T11:09:40Z`, all 18 application/native/static containers were
running the exact `33d9f13a` source with no restarts. All 24 webhook queues were
unpaused and unowned, and PostgreSQL/Redis were healthy. Both readiness endpoints
still returned queue-backlog degradation, with oldest pending age about 57,503
seconds. This was not fleet recovery. The next finite video-owner admission still
refused mirror proof, and a separate two-owner admission refused before proving its
selection; neither refusal stopped the running fleet.

A second independent enqueue starvation defect was reproduced against native
PostgreSQL/Redis: the rotating SQL page advanced over up to 375 chat representatives,
but final batch selection retained only a smaller prefix. With 1,499 permanently
blocked heads and one ready independent chat at position 600, repeated complete
cursor cycles never prepared that chat. The correction bounds each rotating page
by its share of one final-batch reserve and preserves every reserved representative
through merging, prioritization and lifecycle reservation. It keeps the existing
raw scan, final batch, concurrency and exact-head authority bounds. The full-path
regression now reaches the independent chat without releasing unknown heads.

A subsequent bounded mirror audit proved that the remaining oldest video mirror
was outside the six selected configured Major bot identities. The selected owner
was inside that catalog. Source type/clock/identity flags passed for both receipts;
the diagnostic did not identify whether the other receiver was Publisher, retired
Major or unknown. Recovery must retain the profile/catalog boundary until proved.

Materialization also incorrectly rejected an already proved receipt from a prior
sealed certificate in the selected chat, and an oversized unrelated payload could
block preview before scope matching. Preview and the writer now independently
validate prior proof pointers, source digests, scope/status and sealed authority;
they leave that proof intact. Unheld bodies need only bounded scope metadata.
Unknown held sources, invalid pointers and oversized held bodies still refuse.
Native checks cover two separate certificates and independent positive readback.

The `d75e1759` runtime was verified at `2026-10-06T11:37:48Z`: all 18
application/native/static containers matched, all 24 webhook queues were released,
and strict readiness still failed on old queue age (about 59,191 seconds). Both
exact-source CI and CodeQL completed successfully. Bounded post-start enqueue
samples showed preparation progress; they did not prove fleet command latency.

The foreign receiver was independently matched to the configured Publisher in the
exact `33d9f13a` admin generation before its replacement. The next correction binds
that separate profile in both host generations and frozen recovery evidence. It
admits only a source-matching, cleanly processed Publisher mirror with no exact
receipt-linked authority of any kind. That receipt is preserved and not replayed;
Publisher is never added to Major candidate selection.

A further dispatch regression showed that repeatedly eligible slow handoffs could
retake all 32 slots after every bounded poll. The correction retains a capped FIFO
of undelivered scan representatives, re-reads their current receipt eligibility,
and dispatches them before repeated ordinary heads. Live operations keep their
concurrency and same-chat ownership until actual completion. Native coverage uses
real waiting BullMQ jobs and verifies independent progress, changed receipt state,
bot/class capacity and shutdown without increasing the concurrency budget.

## Moderation evidence

The fixed `moderation-outcomes` audit was first inspected with plain EXPLAIN. Its
only base-table walk used `moderation_events_created_at_idx` beneath a 513-row limit.
The native plan fixture included 100,000 retained rows.

At `2026-10-06T09:36:41Z`, the newest 512 sampled events contained six confirmed
administrator bans, recorded between 08:54:28 and 09:07:22, and 27 installed
administrator mutes, recorded between 09:08:43 and 09:32:46. The sample was truncated.
It contained no independently verified mute-deletion events. These facts prove
individual recorded outcomes; they do not establish command latency, current mute
state or successful processing in every chat. No live test sanctions or diagnostic
messages were sent to user chats.

The subsequent snapshot at `2026-10-06T09:54:07Z` included a confirmed administrator
ban recorded at `09:49:12.148`, after the new runtime started. Ten sampled enqueue
log records between approximately 09:49 and 09:54 showed prepared/queued progress
alongside blocked heads, with no sampled handoff errors. These rate-limited log
records are neither a complete throughput measurement nor command-latency proof.

## Capacity and remaining acceptance

The boot disk was expanded online from 350 to 360 GiB, then the root partition and
ext4 filesystem were grown without rebooting. Manifest-aware cleanup reclaimed
about 6.7 billion bytes of unused MAXIM images, retaining current/transition/history
images and every container reference. Volumes, the cold backup disk and sibling
applications were preserved. Before the next build, available Docker filesystem
capacity was about 26.2 billion bytes and passed the mandatory 20 GiB reserve.

Remaining acceptance includes the actual deployed runtime identities, released
queue fences, progress of fresh work and confirmed actions, both strict ready
responses and actionable lag at most ten seconds, exact-SHA CI, and official release
manifest finalization. No successful current manifest may be written by hand.
