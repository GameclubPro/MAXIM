# Storage implementation: guarded first stage

This implements the immediately safe portions of the current storage plan. It
does not authorize body expiry, discard media or shorten product history.

Released as API commit `b3ed5079920f768bf70fba64467810bf6c5d8eea` with manifest
`release-20260929T204809Z-b3ed5079920f`. All 14 API roles and the OCR auxiliary
passed the scoped smokes. Local API validation passed 13,363 tests; exact-SHA CI,
PostgreSQL Races and CodeQL passed. Both receipt-cleanup switches are effectively
false on the owning enqueue role.

The attended live backup was stopped by its watchdog after queue lag crossed
10 seconds (12.6 seconds observed during follow-up). Its PostgreSQL session and
incomplete local archive were removed. This produced **no fresh verified backup
or restore evidence**, so destructive database maintenance remains gated.
Manifest-aware reclaim removed four unused MAXIM images outside the five saved
releases; root free space was 7,477,870,592 bytes at 20:56 UTC, with healthy
ingress/admin and zero queue lag. Public relations remained about 244.8 GiB.

## Changes

- Three payload-only webhook preparation paths compare normalized JSON in the
  existing primary-key/status-guarded UPDATE. Equal JSON returns zero affected
  rows, avoiding heap/TOAST/index rewriting; a changed execution owner is still
  persisted. Status transitions, leases and claim writes keep their semantics.
- Terminal FAILED receipt cleanup now has its own disabled-by-default switch,
  `WEBHOOK_FAILED_RETENTION_ENABLED`. The completed switch did not previously
  stop this hourly path. This holds replay evidence while body/proof separation
  remains unimplemented; it may increase retained history rather than save bytes.
- Storage audits include HOT, WAL, temp/I/O counters and memory setting units
  and sources. Audit-session work memory/parallelism must not be confused with
  application settings. Lease renewal and VK import statements carry fixed
  operation labels recognized by the activity report; these are samples of
  active work, not cumulative operation counters.
- The local encrypted backup has an independent readiness/queue/space watchdog.
  See [runbook](runbooks/watched-postgres-backup.md). A verified archive list is
  not a successful full restore.

## Validation and release

Targeted PostgreSQL 16 tests verify unchanged heap xmin for equal JSON, changed
owner persistence, and terminal-status protection. Existing webhook preparation,
retention and configuration tests cover integration; the real PG test belongs to
the existing CI PostgreSQL Races suite. Storage SQL also executes against PG16
and restricted-role PGlite fixtures. Watchdog tests cover refused starts,
mid-stream abort/reaping, normal completion and helper failure.

Release this API change to all shared-image roles through the exact-SHA CI/image
workflow. It needs no schema migration or stateful-service restart. Synchronize
the reviewed audit tools with the same release, then take fresh bounded storage
and health observations. Stop an active backup normally before an urgent deploy;
never bypass the shared lock.

## Remaining gates

The 300 GiB system disk had about 5.9 GiB free during preflight. A 400 GiB system
disk is a concrete capacity option (+100 GiB); changing a paid cloud resource
needs an operator decision and cloud access. Current local Yandex credentials
return PermissionDenied on instance inventory, so no disk resize was attempted.

Fresh encrypted backup, full isolated restore and maintenance capacity remain
mandatory before dropping even the confirmed duplicate membership index. Its
upper-bound saving is approximately 305 MiB, insufficient to restore the 40 GiB
operating reserve. Do not enable body cleanup or run VACUUM FULL under present
capacity simply because a code release passed.

Compact raw serialization still requires parity for every application and SQL
consumer. Body expiry requires durable replacements for display-name, discovery,
private-dialog and report-history fallback plus a proven replay horizon. The
7/14/30-day body and 90/180/365-day feed alternatives are not approved TTLs.
Historical media migration requires restored-data measurements and CAS/reader
verification. Index rewrites require per-object free-space/WAL budgets.

Use the existing capacity sampler and bounded snapshots for at least seven days
before asserting sustainable growth or enabling unattended cleanup. Neither a
short successful canary nor unit tests substitute for that observation window.
