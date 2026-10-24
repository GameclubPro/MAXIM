# Bounded internal statistics exchange v3

The parallel authenticated `/api/v1/integrations/svyazka/v3` boundary is disabled unless
`STATISTICS_EXCHANGE_V3_ENABLED=true`. Existing v1/v2 strict contracts remain unchanged. Both peers
must advertise all v3 capabilities before automatic consumers use v3. Only an explicitly unsupported
capability response or capability-route 404/405 permits a v2 fallback; malformed responses, denied
credentials and transient failures do not. A legacy complete grant larger than 100 platforms fails
closed with `ROSTER_REQUIRES_V3` and is never truncated.

This is an internal integration for already connected authorized platforms. It creates no owner
screen, switch, supplier branding or technical exchange statuses in ordinary UI or CSV. A roster
never changes platform ownership, publication status or advertising consent. Explicit earlier
refusals remain effective.

MAXIM creates immutable membership snapshots with normalized platform rows and bounded stored
pages. Market verifies the full ordered digest before submitting a compact snapshot reference.
Grant reconciliation checks current actor rights, roster composition/revision, snapshot identity,
expiry, expected grant revision and active leases in the final transaction. An incomplete roster
cannot revoke missing platforms. Access and bounded metadata are separate from the immutable
membership composition. Membership snapshots expire after 15 minutes; grant headers retain their
count/hash and do not depend on the snapshot remaining stored.

Statistics heads contain a frozen native-only content header and separate mutable health/access.
The native collector's stable `generation_id` provides a cheap material revision; repeated heads do
not rebuild 90 days or parse a giant aggregate blob. A changed native generation, authority context or
UTC retention cutoff publishes immutable pages once. Each page request uses the generation/page
primary key and parses at most 200 rows. Envelope bounds apply to serialized UTF-8 JSON, including
escaping. Content SHA covers the shared canonical immutable header; a separate material hash avoids
turning health checks into a new generation. Imported measurements never enter native publication
or collection-handoff evidence.

Scope summaries and health distinguish audience, membership, publication hours, and REACH horizons
0/24/48. A summary's complete statement applies only to its declared `coverageFrom/coverageUntil`;
MAXIM limits that range to actual native enumeration. A later audience/export clock cannot extend
archive proof. Legacy synthetic zeros require native enumeration evidence. Immature timed cohorts
remain incomplete; missing audience is unknown, and empty reach never establishes average views 0.
Legacy internal adapters deliberately leave unscoped REACH freshness unknown.

Reverse compact access scans persist their cursor, structural revision and sweep identity. Each
page applies known denials immediately; only a completed same-revision sweep revokes absent
platforms. Structural per-platform binding counters change on authority/scopes/publicity/binding
changes and remain stable across health renewals. Pinned measurement downloads retain the stage2
page journal, immutable original order/checksum and non-sliding hard expiry. Activation checks a
fresh exact peer proof outside SQL, then current local grant/binding/rights/leases and that latest
proof inside the atomic commit. A frozen head's old health/access revision cannot invalidate
otherwise authorized immutable material. Withdrawal of a scope makes incompatible imported
projections unreadable immediately, even when the binding remains active.

Unchanged content performs no page download or measurement-projection rewrite. Rights and health
still update independently. Corrected/omitted rows replace only their declared producer interval;
empty deletion generations remove values without inventing measured zeros. UTC retention and
snapshot/download expiry use indexed bounded cleanup. Per-credential 429 cooldown is shared by
capability, access, head and page requests and never renews permission TTL.

The complete legacy grant reader uses one grant-header query and one bounded binding/authority
join, including negative authority and unavailable bindings. Import retention selects at most 50
stale projections through the grant/revision/cutoff index. A daily marker lets fresh imports skip
repeated visits; unchanged payloads retain their JSON/TOAST value. A partial sweep resumes after
one second, while a completed sweep waits until the next UTC day. Retention changes neither the
producer revision nor the frozen manifest and never turns omitted rows into measured zeros.

Deploy readers before enabling v3 or persisting grants larger than 100. The rollback floor must
include the explicit bounded legacy reader: retaining an old v2 route does not make pre-v3 database
readers safe for a v3 roster. Release, exact-SHA CI, deployed API acceptance and inside-MAX
acceptance remain separate gates. Native focused tests use the public isolated PostgreSQL 16/Redis 7
wrapper; contract tests and API/Prisma validation use their public lock-owning commands.

After both peers have compatible v3 readers, the exact-green normal production deploy accepts one
explicit caller-only flag:

```bash
STATISTICS_EXCHANGE_V3_ENABLED=true ./infra/scripts/vps-connect.sh deploy main --auto
```

Only literal `true` or `false` is accepted. An absent flag preserves the current dotenv and rollout;
a value stored in local `.env.vps` cannot activate it. The request selects the complete shared API
component even when source images are unchanged. After the release journal and webhook quiescence,
the existing deploy lock protects an atomic update of only `STATISTICS_EXCHANGE_V3_ENABLED` in the
canonical production `.env`; the existing actor cohort and unrelated bytes, ownership and mode are
preserved. Compose and every one of the 14 running API roles must expose the requested literal
before queues resume. Native auxiliaries receive no new environment setting. Ordinary deploy
identity, capacity, migration, readiness and immutable-manifest gates remain mandatory.

Before atomic replacement, a rejected patch leaves the original file intact. A failure after
replacement retains the requested flag and interrupted release evidence; it does not restore stale
configuration or release an unproved queue fence. Recover through the guarded deployment procedure.
Explicit `STATISTICS_EXCHANGE_V3_ENABLED=false` uses the same fenced deploy path to stop v3 use;
v1/v2 readers and retained data remain available under their existing rules. Disabling v3 never
permits an API rollback below the installed migration/reader floor. Enabling the flag and passing
runtime parity do not establish bidirectional exchange acceptance or inside-MAX acceptance.
