# Retire or stop obsolete Publisher slots

This one-time maintenance boundary precedes the entity-authority scheduling rollout.
It covers only `PUBLIK_V1` `ONCE`, `SLOTS` and `RECURRENCE` occurrences scheduled and
created at or before **2026-10-19 23:00:00 UTC (20 October 02:00 MSK)**. Their parent
publication and schedule must also have been created by that cutoff. The exact
Publisher bot comes from the running, same-image admin and Publisher generations.
Strict local live/ready JSON checks run inside the exact admin container; Publisher
is headless. Both generations retain their image, start time and restart identity
through each operation.
The reviewed tooling SHA may be newer than that running image. `NOW`, dynamic
audiences, newer plans and explicit retries authorized after the cutoff are preserved.

## Shared preview and apply gates

Use clean tooling with exact-SHA green `Required` and `Analyze JavaScript and
TypeScript`. Synchronize it through the normal guarded plan path, without enabling
the runtime change. The connector and host wrapper enforce the expected tooling SHA.

Review the preview counts, refusal reasons, completeness and plain query-plan
summaries before applying its digest. Plans are immutable private mode-0600 files
under `/var/lib/maxim-deploy/publisher-obsolete-retirement`; apply receipts stay there.
Apply requires a preview younger than 15 minutes and the same exact runtime
generations, image and tooling source. All commands hold the persistent shared deploy
lock. Both `apply` and `stop-apply` require ordinary maintenance authority. Plans and
continuation digests are bound to their operation: an untouched-retirement preview
cannot authorize or continue stop-only work, or vice versa. Credentials stay inside
the existing Publisher container; no application context or MAX call is started.

The full leading prefix of the existing ready index is fixed: profile, status and
one exact blocker (including NULL). Within that partition,
`(scheduled_at,id)` provides stable pagination even when many slots share a time.
A separate one-row index seek discovers the next blocker. Private continuation
cursors advance over safe and refused rows. `sourceComplete=false` requires further
pages; a zero-candidate page does not mean there is no remaining work.

Before each distinct read shape, production runs plain `EXPLAIN` and refuses scans,
sorts, filters or unknown indexes. It never runs live `EXPLAIN ANALYZE`. Native local
tests exercise actual PostgreSQL query visits under skew and equal-time cohorts.
The maintenance session discourages sequential/bitmap scans and explicit sorts so a
small remaining status partition cannot make a cheaper sorted path displace the bounded
ordered index. The same plan guard still rejects any resulting sort or filter.
Failures expose only fixed diagnostic codes, allowed SQLSTATEs, a query-shape digest
and known plan-node/index metadata. SQL, parameters and raw errors remain private.
An apply diagnostic never establishes whether a transaction committed; retain its
evidence and follow the unknown-outcome procedure below.

## Retire untouched slots

The existing `preview`/`apply` operation requires proof that no send or action effect
has started. It preserves its original eligibility rules.

```bash
./infra/scripts/vps-connect.sh publisher-obsolete-retirement preview
read -r -p 'Reviewed previewDigest: ' retirement_digest
./infra/scripts/vps-connect.sh publisher-obsolete-retirement apply --reviewed-digest "$retirement_digest"
./infra/scripts/vps-connect.sh publisher-obsolete-retirement preview --after-digest "$retirement_digest"
```

Each page samples at most 32 occurrences plus a sentinel for each of `SCHEDULED`,
`IN_PROGRESS` and `FAILED`. Details are capped at 128 targets/deliveries, two entity
envelopes and one slot per envelope. A sentinel or malformed/mismatched relationship
refuses the occurrence. Envelope audience JSON is inspected only after proving
uncompressed storage at most 16 KiB; nested guards precede type/array-length parsing
and the 128-target cap.

Only a whole occurrence can be canceled. Its current parent versions and immutable
content identity must match the preview. Every saved target and envelope must agree;
envelopes cannot cycle or target all chats. Every delivery must remain `PENDING` with
zero attempts, no lock, receipt, verification, subscription handoff or action effect.
Configured `NONE`/`PENDING` pin/delete intent with zero execution counters may remain,
including its original `delete_at`. Unknown errors and any saved first SEND ledger
row refuse cancellation, regardless of that ledger row's status.

Apply takes the calendar advisory lock and parent/child row locks, rechecks the full
snapshot and all no-effect predicates, then atomically marks the occurrence, its
deliveries, envelopes and envelope slots `CANCELED`. An injected failure on a second
target must roll back the first target too. No record or fence is deleted. Parent
publications/schedules and their future slots remain unchanged; no queue is reset.

## Stop remaining dispatch intents

The separate `stop-preview`/`stop-apply` operation stops further dispatch for reviewed
old scheduled intents while retaining their complete execution evidence. It does
not require proof that a delivery is untouched and does not mean an earlier send
failed or never happened.

```bash
./infra/scripts/vps-connect.sh publisher-obsolete-retirement stop-preview
read -r -p 'Reviewed stop-only previewDigest: ' stop_digest
./infra/scripts/vps-connect.sh publisher-obsolete-retirement stop-apply --reviewed-digest "$stop_digest"
./infra/scripts/vps-connect.sh publisher-obsolete-retirement stop-preview --after-digest "$stop_digest"
```

Discovery covers all seven occurrence states: `SCHEDULED`, `IN_PROGRESS`, `FAILED`,
`SENT`, `PARTIAL`, `AMBIGUOUS` and `CANCELED`. This includes a terminal occurrence
whose attached envelope still permits fallback dispatch. Each visited status head
samples at most 32 rows plus its sentinel, with a global maximum of 96 sampled rows
and candidates per page. Unvisited status cursors stay unchanged for the next page.
An occurrence already `SENT` or `CANCELED` with no runnable envelope requires no action.

The stop-only frozen snapshot contains the publication, schedule, occurrence, at
most two entity envelopes and at most one slot per envelope. Each envelope slot
read uses `LIMIT 2` to detect an extra slot. Envelopes must remain noncycling with
`cycle_enabled=false` and `cycle_count=1`; a saved slot must have index 1 and the
occurrence's scheduled time. Exact parent, bot/profile and legacy-envelope
associations must hold. The shared cutoff, scheduled-mode, `SNAPSHOT` audience and
newer-explicit-retry exclusions still apply. Differences in saved targets or
audience, the parent's current canonical content revision, or its current schedule
revision do not block this operation. The current frozen snapshot must still match
at apply; a racing edit or retry requires a fresh preview.

Apply takes the calendar advisory lock and row locks before checking the frozen
snapshot and compare-and-set predicates. In one occurrence transaction it changes
`SCHEDULED`, `IN_PROGRESS`, `FAILED`, `PARTIAL` or `AMBIGUOUS` occurrences to
`CANCELED`, and changes attached `ACTIVE`, `PARTIAL` or `FAILED` envelopes to
`CANCELED` with `next_send_at=NULL`. Occurrence states `SENT` and `CANCELED` remain
unchanged. `COMPLETED` and already `CANCELED` envelopes remain unchanged. A failed
compare-and-set or later-envelope write rolls back every change for that occurrence.

All child delivery and slot rows, locks and tokens, remote receipts, verification
history, SEND ledger, subscription handoffs and post-actions remain untouched.
Parent publications, schedules and future slots remain unchanged. An existing
in-flight MAX request may finish and its late acknowledgement may update the saved
delivery. A canceled envelope remains a dispatch fence: those late results do not
automatically project it back to a delivery-derived envelope status. Its retained
delivery evidence, including uncertainty, still describes the action outcome.
A parent occurrence marked `CANCELED` by stop-only does not prove zero SENDs: it
records that further dispatch is stopped, including when the retained deliveries
show partial success or an ambiguous result.

## Completion and unknown outcomes

If a later candidate races, earlier committed cancellations remain valid. A missing
acknowledgement is an unknown outcome: retain its private evidence, wait through the
fixed 90-second operation boundary and make a fresh preview. Never replay a SEND or
reset a lock to force acceptance.

`sourceComplete` describes the sampled cursor traversal, not an immutable fleet
inventory: live workers may change a status/blocker between pages. After completing
all reviewed pages, start a fresh preview from the beginning and examine any
remaining eligible/refused old slots before enabling the runtime. Refusals, missing
coverage and races remain explicit release gates; a healthy sample cannot establish
that all obsolete work was retired.
