# Retire untouched obsolete Publisher slots

This one-time maintenance boundary precedes the entity-authority scheduling rollout.
It covers only `PUBLIK_V1` `ONCE`, `SLOTS` and `RECURRENCE` occurrences scheduled and
created at or before **2026-10-19 23:00:00 UTC (20 October 02:00 MSK)**. The exact
Publisher bot comes from the healthy, same-image admin and Publisher generations.
The reviewed tooling SHA may be newer than that running image. `NOW`, dynamic
audiences, newer plans and explicit retries authorized after the cutoff are preserved.

## Preview and apply

Use clean tooling with exact-SHA green `Required` and `Analyze JavaScript and
TypeScript`. Synchronize it through the normal guarded plan path, without enabling
the runtime change. The connector and host wrapper enforce the expected tooling SHA.

```bash
./infra/scripts/vps-connect.sh publisher-obsolete-retirement preview
read -r -p 'Reviewed previewDigest: ' retirement_digest
./infra/scripts/vps-connect.sh publisher-obsolete-retirement apply --reviewed-digest "$retirement_digest"
./infra/scripts/vps-connect.sh publisher-obsolete-retirement preview --after-digest "$retirement_digest"
```

Review the preview counts, refusal reasons, completeness and plain query-plan
summaries before applying its digest. Plans are immutable private mode-0600 files
under `/var/lib/maxim-deploy/publisher-obsolete-retirement`; apply receipts stay there.
Apply requires a preview younger than 15 minutes and the same exact runtime
generations, image and tooling source. Both modes hold the persistent shared deploy
lock. Apply also requires ordinary maintenance authority. Credentials stay inside
the existing Publisher container; no application context or MAX call is started.

Each page samples at most 32 occurrences plus a sentinel for each of `SCHEDULED`,
`IN_PROGRESS` and `FAILED`. The full leading prefix of the existing ready index is
fixed: profile, status and one exact blocker (including NULL). Within that partition,
`(scheduled_at,id)` provides stable pagination even when many slots share a time.
A separate one-row index seek discovers the next blocker. Private continuation
cursors advance over safe and refused rows. `sourceComplete=false` requires further
pages; a zero-candidate page does not mean there is no remaining work.

Before each distinct read shape, production runs plain `EXPLAIN` and refuses scans,
sorts, filters or unknown indexes. It never runs live `EXPLAIN ANALYZE`. Native local
tests exercise actual PostgreSQL query visits under skew and equal-time cohorts.
Details are capped at 128 targets/deliveries, two entity envelopes and one slot per
envelope. A sentinel or malformed/mismatched relationship refuses the occurrence.
Envelope audience JSON is inspected only after proving uncompressed storage at most
16 KiB; nested guards precede type/array-length parsing and the 128-target cap.

## Cancellation proof and limitations

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
