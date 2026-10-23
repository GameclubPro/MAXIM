# Statistics exchange audit

This opt-in report inspects one exact MAX actor through the existing bounded audit
role. It performs no remote calls, repairs, synchronization or permission changes.

```sh
./infra/scripts/vps-connect.sh postgres-audit statistics-exchange "$MAXIM_AUDIT_ACTOR_ID" --explain
./infra/scripts/vps-connect.sh postgres-audit statistics-exchange "$MAXIM_AUDIT_ACTOR_ID"
```

Set the private caller variable `MAXIM_AUDIT_ACTOR_ID` to the exact positive actor ID. Keep it private. The catalog accepts one decimal ID of at most
20 digits and the optional `--explain` flag. SQL, paths and stdin are not inputs.
Collect the plain plan and report sequentially under the unchanged eight-second
wall and 2.5-second statement budgets. The generic prepared plan does not execute
the report or expose the actor value.

After synchronizing this tooling, provision the reviewed audit role using
`postgres-audit-provision --apply`. The 37-column exchange group is optional for
older schemas: the complete schema receives the exact group, a missing group
receives none, and partial/effective inherited/table/mutation grants fail closed.
The report itself requires the complete group and attests the actor unique index,
entity/import primary keys and latest-generation index before reading rows.

The query performs one actor/grant lookup, samples six entities with a seventh-row
saturation sentinel, and reads at most one current-revision import and one latest
native export for each sampled entity. It admits bounded JSON before inspecting
at most 3,000 measurements per snapshot. Physical compression bounds deliberately
reject some valid large compressed values; rejected evidence remains unknown.

Output contains aggregate counts, revisions, error booleans, pull/access clocks,
the minimum/maximum stored peer permission expiry, valid/expired/missing entity
authority and remote-binding counts, expired/missing import authority, actual
observation times and coverage by platform kind, producer and metric. Join IDs,
raw errors, manifests and measurements are never output. Native exports must keep
MAXIM provenance; imports must keep EXCHANGE provenance. Mismatches invalidate
the `native_only` evidence.
Retained imported rows may have an older safe producer revision after an interval
correction; a native immutable export requires its exact generation revision.

The output describes the bounded sample. It does not prove full grant coverage,
current remote rights, checksum validity, collector handoff or end-to-end delivery.
An export/storage timestamp never refreshes actual observations. An absent grant,
missing metric or rejected JSON is not a measured zero. Expired peer permission
metadata is separate from MAXIM's local binding rights and must not be substituted
with the local expiry. No report result authorizes replay or a test publication.
