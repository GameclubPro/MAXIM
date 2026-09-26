# Publisher Publication Diagnostics

Use the fixed read-only catalog to distinguish missing actor access, missing bot/catalog
evidence, disabled publication policy and attempted/ambiguous deliveries:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-publications --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-publications
```

After synchronizing this catalog, preview and apply the reviewed audit-role provision
step before using it. It grants 43 exact publication/access metadata columns and expands
the existing Publisher binding/comment group from 14 to 16 columns. Identifiers are
used only for exact joins; report output contains fixed categories and aggregate counts,
not identifiers, publication text, media, URLs, token values or raw permission snapshots.
The role has no business-data write privilege and retains the existing one-connection,
read-only, statement, lock, wall-clock, memory and temporary-file limits.

The report samples the oldest 32 due PUBLIK_V1 occurrences for each of SCHEDULED,
IN_PROGRESS, AMBIGUOUS and FAILED. Each selected occurrence contributes at most eight
target slots and eight delivery rows. One extra row detects truncation at each boundary.
Required indexes are attested before the query; `--explain` never executes it.

Counts describe sampled occurrence/target/delivery slots, not unique users or entities.
Repeated schedules can therefore contribute the same recipient more than once. Saturated
or truncated samples are not a complete inventory. `metadata_ready` does not prove MAX
write permission: raw permission data is deliberately outside this diagnostic.

Interpret all blockers together with lifecycle and schedule status. A disabled policy or
fresh denied actor must never be silently enabled or granted access. A missing/expired
cache may nominate an exact Publisher-owned verification, not authorize a send. A remote
message ID or an attempted/AMBIGUOUS delivery must retain its receipt and dispatch fence.
No report outcome authorizes bulk retry or recreating a failed publication as a new send.

This command makes no MAX calls, runs no publication workers and changes no queue or
application state. Use normal product authentication for any separately reviewed action.
