# PostgreSQL storage audit

Use this fixed catalog report when filesystem inventory identifies PostgreSQL as
the main disk consumer. It does not read application rows, change retention,
vacuum tables, or grant access to application data.

After synchronizing the reviewed diagnostic tooling to the VPS:

```bash
./infra/scripts/vps-connect.sh postgres-audit storage --explain
./infra/scripts/vps-connect.sh postgres-audit storage
```

The first command uses plain EXPLAIN, without executing the report. The second
runs through the existing `maxim_audit` role, global audit lock, read-only
transaction, 2.5-second statement timeout, eight-second wall deadline, bounded
memory/temp settings, disabled parallelism and exact-backend cleanup. Existing
audit-role attestation must pass; this mode adds no grants. It is deliberately
excluded from `postgres-audit all` and routine monitoring.

Measurement is limited to 512 ordinary public tables/materialized views and
4,096 associated indexes. Exceeded limits are explicit; do not interpret absent
measurements as zero storage. Output includes aggregate bytes and the largest
32 tables and 32 indexes, estimated live/dead row counts, cumulative mutations,
vacuum/analyze timestamps, statistics reset time and selected storage settings.
The catalog also reports HOT updates, database temp/I/O/transaction counters and
cluster WAL counters, each with its own reset timestamp. Compare deltas only
within an uninterrupted statistics window. WAL is cluster-wide, not attributable
to one table. A HOT ratio describes observed updates, not index bloat.

Memory settings include units and source/reset metadata. These are the **audit
session's** settings: its forced `work_mem=1MB` and disabled query parallelism do
not describe application sessions. `shared_buffers` uses 8 KiB blocks; `work_mem`
and maintenance memory use KiB. Do not multiply `work_mem` by connections alone
to claim actual RAM use; sorts/hashes and parallel workers matter too.
It also reports up to 32 groups of valid/live indexes with identical access
method, key/include columns, operator classes, collations, ordering, expressions
and predicates. Uniqueness, constraint ownership, replica identity and clustering
are reported separately. These are review candidates, not automatic DROP targets;
retain constraints and inspect dependencies and recovery cost before any DDL.

Interpret the report as follows:

- `total_bytes = table_bytes + indexes_bytes`; table bytes already include TOAST
  and its index. Do not add `toast_bytes` again. Public relation totals exclude
  WAL, other schemas/databases, filesystem metadata and other Docker volumes.
- Relation sizes come from file metadata, not scans of stored messages. Counts
  from PostgreSQL statistics are estimates and may lag or reset. Cumulative
  mutations and index scans need a second comparable observation before they
  can describe a rate; zero scans alone do not justify dropping an index.
- Dead row counts are not a measurement of bloat or immediately recoverable disk
  space. Ordinary VACUUM normally makes internal space reusable. DELETE does not
  generally shrink relation files, and rewrites/reindexing require separate disk,
  locking, backup and maintenance planning.
- Confirm effective retention settings on the owning runtime role and inspect
  the corresponding source before changing policy. Preserve active work,
  deduplication and ambiguous-delivery evidence; the product's message-retention
  feature is different from database event retention.
- Keep backup and restore workloads on their dedicated cold filesystem. Never
  remove PostgreSQL files or Docker volumes as an optimization, and do not treat
  Docker's generic reclaimable image estimate as a release-aware deletion plan.

Repeat filesystem free-space and health observations after any separately
reviewed maintenance. Application writes continue during an audit, so snapshots
from different times will not reconcile byte-for-byte.
