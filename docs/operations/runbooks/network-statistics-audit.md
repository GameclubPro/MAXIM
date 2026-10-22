# Network statistics evidence

Use the opt-in `postgres-audit network-statistics` collector before accepting network
statistics and after the affected runtime release. It reads the existing channel statistics
schema, including when the new observation tables have not been deployed. It does not
contact MAX, refresh statistics, change favorites or publish messages.

After synchronizing the reviewed scripts, preview and apply the existing audit-role
provision procedure. It adds exactly fifteen metadata-column SELECT grants across audience
snapshots, synchronization state, posts and view snapshots; it grants no post content,
author, reaction, full-table SELECT or mutation access. Older incomplete schemas receive
none of this group, and this mode then fails closed.

Select at most twelve exact negative numeric entity IDs. Verify the deployed source/image
and actual entity type separately. Run the plain plan first, then the report, sequentially:

```bash
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --explain
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799'
```

Both calls retain the shared audit lock, dedicated one-session read-only role, five-second
role timeout backstop, 2.5-second per-statement wrapper budget, maximum eight-second wrapper
wall limit, small memory/temp limits and exact
five-index attestation. Plain EXPLAIN never uses ANALYZE. Do not increase these limits or
replace the collector with ad hoc SQL when evidence is missing.

Each selected entity reads its newest and oldest audience snapshot and exact synchronization
state. Post sampling takes at most twenty-five indexed heads, reports at most twenty-four
posts, and reads at most two newest view snapshots per post. The twenty-fifth head is a
saturation sentinel. A capped sample describes only this recent prefix; it does not establish
full-history coverage, complete retention, unique audience or all period views.

Retain observation time, exact scope, missing rows, saturation, source/image and the report
exit status in the private task record. Coverage timestamps and a successful sample establish
only persisted observations. They do not prove MAX rights, past growth outside coverage,
historical post-view accuracy or production acceptance of the new aggregation. In particular,
old snapshots may have been pruned and unchanged polls may not have produced snapshots;
missing observations must remain gaps. No result authorizes replay, repair or publication.

After the additive network foundation is deployed, provision the audit role again. The
separate optional observation group grants exactly forty-five metadata-column SELECTs
across the four observation/archive tables and the existing marketplace collector bindings.
Partial schemas receive none of this group. It grants no post content, actor/bot/binding
identities, cursor signatures, lease tokens, full-table SELECT or mutation privileges.

Request post-foundation evidence explicitly, retaining the same exact entity scope:

```bash
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --observations --explain
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --observations
```

This schema-v2 mode requires all forty-five grants and ten attested indexes before its
report. It adds each exact entity's persisted audience observation and archive checkpoint,
then reads observation state and at most two newest intervals for each of the same
twenty-four sampled posts. Intervals are capped before checking their entity match; a
false `chat_matches` is a data-integrity gap. Missing baselines remain null, interval lists
remain empty, and observation writer sources are classified as `major`, `marketplace` or
`other`. They are not current collector ownership proof.

Collector metadata reads at most nine indexed binding heads per entity and reports at
most eight, using the ninth as a saturation sentinel. It reports stored owner/profile,
metric flags, lease expiry, consent, validity and native-history freshness without identifiers
or raw JSON. These observations deliberately set `authority_verified: false`: the report
does not re-prove the full local grant, current membership, process ownership, scheduler
execution or MAX capability. An uncapped empty binding sample means only that no stored
bindings were found for that exact entity. Neither a live lease nor a recent observation
establishes that work is still progressing; compare fresh sequential samples and retain
their timestamps and gaps. The default mode remains compatible with the old schema and
reports only the new observation table's presence, never substitutes that for v2 evidence.

Membership evidence is a separate opt-in schema-v3 mode. Reprovision through the same
preview/apply procedure before use. The independent group grants exactly eight columns:
`chat_id,bucket_start,joined_users,left_users,updated_at` on membership rollups and
`chat_id,event_type,event_at` on membership feed items. A missing or partial schema grants
none; partial effective grants, inherited/PUBLIC private-column access, table SELECT and
all mutation privileges fail closed. Canonical/source, actor, user and bot identities stay
ungranted. Existing fifteen/forty-five-column modes remain independent; `all` excludes
this report.

```bash
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --membership=7d --explain
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --membership=7d
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --observations --membership=30d --explain
./infra/scripts/vps-connect.sh postgres-audit network-statistics '-78271094414679,-78271171091799' --observations --membership=30d
```

Collect these sequentially. Membership alone attests nine exact btree indexes; combined
observations/membership attests fourteen. Besides the existing five/ten, it requires the
unique `(chat_id,bucket_start)` rollup primary key, rollup chat/bucket descending index,
feed chat/event/time/source descending index and feed chat/time/source descending index.
Attestation checks exact keys/directions, table identity, uniqueness where required,
valid/ready/live state and absence of expressions/predicates. Private join-only index keys
do not receive SELECT grants.

Each statement uses one fixed observation time and the runtime's seven/thirty Moscow
calendar days. UTC-hour bounds split complete rollups from the current incomplete hour.
Each exact entity selects at most 721 rollup candidates, retains 720 and exposes saturation;
each literal `user_added`/`user_removed` current-hour branch selects at most 1,001 and
retains 1,000. Every LIMIT is inside its index-range probe before aggregation. Six additional
indexed LIMIT-1 heads expose oldest/latest rollup and each membership event type. At most
thirty daily rows per entity leave the report. Neither deep history nor another entity
widens these bounds. The existing 2.5-second statement, eight-second psql wall, 1 MB work
memory, 8 MB temp and disabled parallelism budgets stay unchanged. A timeout requires
reporting the evidence gap, lowering a reviewed fixed sample cap or using independent
opt-ins sequentially; never increase production budgets.

The primary key guarantees unique timestamps, not aligned hours. The capped candidate
sample reports `misaligned_bucket_count` and `invalid_counter_count`; either makes derived
net values null. Any saturated join, leave or rollup branch also makes net null. Sampled
join/leave counts remain individual lower bounds: subtracting them does not produce a
net lower bound. No retained membership rows means null/empty observations, even when
the audience poll or membership-start metadata is fresh. A genuine observed zero is
distinct. Missing days remain absent, rather than an invented flat history.

Retain raw first/last feed/rollup times, synchronization-start metadata, named `basis`,
period/as-of, caps and integrity gaps. `max_processing_updated_at` is processing metadata;
it is not activity freshness or a collector heartbeat. `continuous_delivery_verified` stays
false. Per-metric API `coverage.asOf` uses that metric's observations conservatively across
included entities: an audience-only poll cannot refresh growth. Earliest observations do
not establish a date of continuous coverage for every entity. Source/rollup parity proves
neither MAX authority, collector ownership, continuous webhook delivery nor complete history.

For networks larger than twelve entities, take IDs from fresh server catalogue pages and
retain category compositionVersion before/after sequential batches. Compare closed buckets
per entity. Different snapshots, as-of times, changing composition and current-hour arrivals
prevent claiming exact same-snapshot parity for a whole network from one subset. Record
source/image, exact entities/types, window, each exit status and missing evidence privately.
Native disposable PostgreSQL tests establish physical work and full protected-wrapper timing;
PGlite/parser tests and plain production EXPLAIN alone do not establish that timing gate.
