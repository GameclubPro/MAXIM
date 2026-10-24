# Central statistics audit

This opt-in report checks the central statistics store for at most twelve exact
connected channel/chat IDs. It performs no remote calls, repairs, exchange,
permission changes or publication actions.

```sh
./infra/scripts/vps-connect.sh postgres-audit central-statistics "$MAXIM_AUDIT_ENTITY_IDS" --explain
./infra/scripts/vps-connect.sh postgres-audit central-statistics "$MAXIM_AUDIT_ENTITY_IDS"
```

Set the private caller variable to comma-separated distinct negative decimal IDs,
each at most twenty digits. SQL, paths and stdin are not accepted. Collect the
plain generic plan and report sequentially. The plan does not execute the report
or expose the input IDs. The existing global lock, eight-second wall,
2.5-second statement, read-only, memory, temporary-file and no-parallelism budgets
remain unchanged. Local sort planning is discouraged so each capped source uses
its ordered index; subsequent aggregation reads bounded metadata only. This mode
is excluded from `all`.

After synchronizing the tooling and installing the central schema, provision the
reviewed role through `postgres-audit-provision --apply`. The new optional group
contains exactly 35 metadata columns across the five central tables. A missing
schema receives none; incomplete, extra, inherited, table-level or mutation grants
fail closed. The report requires this group plus the existing complete network
base and observation metadata groups. It reads no measurement values, coverage
payloads, receipt results, hashes, message text or permission payloads. IDs and
receipt operation keys remain inside SQL for indexed lookup/order only.

Both channel and chat types are probed for each input ID through the unique
entity index. Each matched entity reads at most 1,441 measurement metadata rows
for the current ninety UTC days, including the saturation sentinel. Each of the
four fixed issuer/role authority prefixes reads at most 65 rows. Saturated
authority groups never establish a candidate source/consumer pair. Candidate
pairs require the same entity, actor, purpose and consuming service with two
unexpired active leases. They do not establish metric scopes, current configured
producer epoch or current local/remote bot rights; runtime acceptance must verify
those separately.

Measurement metadata reports producer, metric, method, horizon, tombstones,
actual observation times and storage times separately. Native MAXIM history is
partly virtual and need not appear in central measurement rows. Independent
indexed native probes therefore report raw audience and view observation times.
They do not authorize access or establish the canonical selected value. A new
lease or ingest timestamp does not refresh an old observation.

The native audience discriminator is PostgreSQL `ChatEntityType`. Cast the bounded
probe value to that enum, keeping the indexed column unchanged. The disposable
PostgreSQL regression uses the production enum; a text-only fixture misses this
operator boundary and cannot validate the live report.

Global receipt and change samples are explicitly separate from the requested
entity scope: each reads at most 257 recent rows and reports at most 256. The
unpublished feed head likewise uses a capped oldest-first partial-index probe.
Saturation means the count is a lower bound; these are never full history totals
or proof of delivery. Required indexes, key order, uniqueness and the unpublished
predicate are attested before reading rows. Missing evidence stays unknown.
