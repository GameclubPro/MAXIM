# Message Retention Hardening

Scope: the 24/48-hour Major chat module, its shared deletion boundary, and its mini app surface. Runtime deletion stays off until the existing capacity/canary gates pass.

## Findings And Work

- [x] P1: remote guard reads could occur after reservation of the DELETE transport slot. Prepare remote evidence first; transport-final checks are database/cache-only and defer when evidence expires.
- [x] CI: the participant-report test double used a read/create upsert under concurrent commands. Use atomic insert-if-absent operations to match the production deletion ledger's behavior; report runtime logic is unchanged.

- [x] P1: expired author-cache entries can survive an inconclusive refresh. Reject unknown or expired evidence, including slow pin/member reads.
- [x] P1: stale worker policy snapshots can cancel a newly enabled activation. Fence settlement and rescheduling against current database authority.
- [x] P1: garbage collection can remove the candidate while preserving an ambiguous intent, orphaning its recovery. Retain both together and prevent blocked receipts from starving bounded cleanup.
- [x] P2: admission uses many sequential queries and holds quota locks through them. Consolidate eligibility, locks, and mutations into three bounded statements; test rollback/deduplication against PostgreSQL.
- [x] P2: paused/off MAX execution also stops database housekeeping; worker errors can remain visible after recovery. Separate maintenance from dispatch and update status from the current run.
- [x] P2: canary scheduling scans unrelated policies; shutdown does not drain an active scheduler. Filter the cohort before selection, bound time/work and drain owned scheduling.
- [x] P2: conflict recovery is disabled while the editor is dirty, cached polling can defeat refresh, and loading/error feedback is weak. Preserve drafts, explicitly resolve revisions and make failures recoverable.
- [x] UI: use full-width native mode controls, a clear runtime status, compact counters, responsive typography, stable loading and accessible save/back behavior without eagerly loading the editor.

## Verification

- Focused regression tests for cache expiry, activation races, shutdown, quotas, cancelled/ambiguous receipts, and status recovery.
- Execute production SQL on a disposable PostgreSQL-compatible test database; use the CI PostgreSQL lane for concurrent clients.
- Browser checks across iPhone/Android, narrow and desktop widths, light/dark, keyboard/back, loading, errors, conflicts and long counters. Keep production bundle budgets unchanged.
- Run the scoped public checks and exact-SHA CI, deploy affected components through repository wrappers, then verify healthy runtime and retention mode off.

## Deferred Gates

Local verification completed: the public full check, production bundle budgets, PostgreSQL-compatible SQL tests, and browser recovery/back/conflict scenarios. The PostgreSQL CI lane also runs the same storage suite with concurrent clients before release.

Passing these checks is not certification of fleet-wide throughput. The representative two-million-record load run and 72-hour executing canary remain required before enabling deletion.
