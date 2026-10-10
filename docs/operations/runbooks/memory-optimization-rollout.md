# Memory optimization rollout

This rollout reduces repeated Queue providers, avoids HTTP/Admin composition in
message retention, removes internal media copies and releases expired local cache
values. It adds process and recovery-phase measurements before changing resource
limits or recovery algorithms. Bot routing, SQL ownership, lease/CAS generations,
deadlines, attempts, priority, dispatch proofs and quarantine remain authoritative.

## Implemented boundaries

| Stage | Runtime change                                                                                                       | Remaining evidence or gate                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P0    | Fixed process RSS/heap/external/arrayBuffer gauges, GC counters and bounded event-loop histogram in existing reports | Representative warmed windows, media peaks and an RDB cycle                                          |
| P1    | Shared name-only Bull registration metadata, one provider per queue per Nest context                                 | Compare aggregate client census before/after; worker blocking clients remain independent             |
| P2    | Shared runtime/HTTP separation and explicit headless retention root                                                  | All production-role DI matrix and retention guard graph                                              |
| P3    | Actual-byte-capped streamed downloads, binary forward-import DTO, bounded VK encoded-media reservations              | Native/OCR representation changes and admission for other entry paths need dedicated lifecycle tests |
| P4    | Incremental expiry sweep for membership/bot-binding/spammer values; reconstructible spammer L1 entry cap             | Fresh bot bindings, in-flight owners and authority/proof maps cannot be capacity evicted             |
| P5    | Compatible observational counter readers and versioned minute writer                                                 | Two releases: readers first with legacy writer, writer activation with rollback floor second         |
| P6    | Expire/select/handoff durations and acknowledged/error/unknown-insertion counts                                      | Optimize the measured slow phase; acknowledgements include existing jobs                             |
| P7    | Existing storage diagnostics continue                                                                                | Historical backfill/expiry/rewrite requires a fresh encrypted full backup and isolated restore       |
| P8    | Resource settings preserved                                                                                          | Hard caps, PostgreSQL tuning and smaller VM require representative pressure/capacity validation      |

`registerRuntimeQueues` caches only name-only DynamicModule metadata inheriting the
same Bull root policy. Custom prefix/connection policies must not use it. Queue
instances remain local to a Nest context, with one close owner. Nest workers inherit
their Queue options; blocking connections and fail-fast producer connections cannot
be combined arbitrarily.

`SystemRuntimeModule` keeps the full queue inventory, mode/governor, readiness and
ledger watchdog. `SystemModule` adds HTTP/controllers/dashboard. The explicit
retention role imports `RuntimeCoreModule` and `MessageRetentionModule`, including
the unchanged delete guard graph. Production Compose supplies `APP_ROLE` before
bootstrap. Startup without an explicit role retains the full dotenv-compatible root.
Other roles retain their previous composition until independently verified.

VK reservations cover encoded buffers for download/upload, acquired before bytes
are fetched. Queued saturation uses the existing pre-dispatch defer protocol with
the exact intent key and no consumed attempt. Review preparation has a bounded
metadata-only wait. Already-started image siblings settle before reservation release.
The 768 MiB process budget is a reservation policy, not an RSS or native-raster cap.
Direct browser-to-MAX video upload and certified OCR decisions stay unchanged.
Forward imports retain three download lanes and their claim lease; their internal
binary DTO avoids base64 conversion without changing canonical media validation.

## Compatibility release

Validate affected code, all role graphs and exact-SHA `Required` plus `Analyze
JavaScript and TypeScript` CI. Use the normal wrapper; any API role expands to all
14 shared-image roles and the OCR auxiliary. PostgreSQL/Redis are not recreated.
Keep `MAX_API_METRICS_STORAGE_LAYOUT=legacy` in this release. Do not install the
minute-reader rollback floor until the second writer-activation release: the prior
legacy image remains a valid rollback target while no minute events are written.

```bash
./infra/scripts/vps-connect.sh deploy main --plan
./infra/scripts/vps-connect.sh deploy main api-admin
./infra/scripts/vps-connect.sh exec docker compose -f infra/docker-compose.yml exec -T api-admin node apps/api/dist/apps/api/src/scripts/audit-storage-runtime.js
```

Use the existing exact-SHA CI-image preload when build capacity requires it. Never
lower the 20 GiB API build floor. Required online multibot preparation separately
checks and supervises a 10 GiB filesystem reserve; its peak estimates are advisory.
Preserve typed release/queue-fence journals and run all
strict smokes. After one readiness timeout, inspect lag trend, host I/O, PostgreSQL
activity and backup services before retrying or extending timeouts.

## Minute-writer activation

Only after every role has the compatible reader and the first release is healthy,
ship the second release enabling the minute layout. The activation source defaults
validated runtime configuration and `.env.example` to `minute`; an existing explicit
`legacy` environment value still overrides that default. Verify only the effective
layout enum across all 14 roles, without printing the rest of the environment.
Production roots validate configuration through `RuntimeCoreModule`; the
`MaxClientService` fallback remains legacy for callers without validated configuration.

The activation release API rollback paths must reject sources without `MAX_API_METRICS_MINUTE_READER_VERSION = 1` and actual
`readMaxApiMetricCounts` wiring. The compatibility release is the rollback floor;
static-only rollback is unaffected. Preserve the source floor after a writer
downgrade because minute counters can remain for six hours.

Invoke every subsequent API rollback through the current reviewed `main` copy of
`vps-connect.sh`, including after a ref rollback leaves the VPS checkout detached on
the compatibility release. The wrapper requires the newer multibot-authority entrypoint
marker for ref rollback and immutable rollback that selects API; minute-reader and
old recovery markers alone are insufficient. Current tooling still enforces the
minute-reader source floor. When necessary, its existing shared-lock bootstrap restores
retained reviewed `main` tooling after the clean-tree and exact-main checks. It does
not fetch or relax recovery guards. Current API tooling and static-only immutable
rollback retain their existing offline fast paths. Do not invoke the older
compatibility checkout's rollback wrapper or entrypoints directly.

Each event increments exactly one layout. Readers add disjoint legacy and minute
events for the same second; dual writing would double counts used by governors.
Minute hashes retain 60 exact second fields rather than coarse minute averages.
Observational global/source/outcome history remains six hours. Service counters
retain their legacy keys and relative 120-second TTL even in minute mode: public
readers support longer windows, including the oldest partly live second after its
last increment. Packing those short counters would change that boundary. First source metric and catalog registration share
the original transaction; process registration is remembered only after success.
The catalog is not pruned. Authoritative `maxapi:gcra:v1:*` reservations and their
two-second TTL are outside this change.

Let legacy keys expire naturally. Do not flush Redis or delete queue/proof keys.
Compare mixed-format counts using deterministic tests and observe live fixed
capacity counters; a restart or a six-hour transition is not steady-state savings.

## Measurements and acceptance

Existing fixed reports publish every 30 seconds and expire after 90 seconds; the
admin audit CLI reads their allowlisted scalars without MAX/SQL calls. New optional
fields preserve old reports and use null for missing/corrupt measurements. Memory
gauges overlap: arrayBuffers is part of external, heapUsed part of heapTotal. Never
sum these gauges into RSS. GC counters begin at module initialization; event-loop
percentiles cover the cumulative native histogram including its 100 ms resolution,
not API latency or a 30-second rolling window. VK admission reports reserve/active/
waiting/peaks only, with no URLs, identities or media.

Due-sweep stage counters distinguish selected IDs, attempted handoffs and Redis
acknowledgements. An acknowledgement may resolve to an existing Job and does not
prove a newly inserted Job or a completed delete. Preserve independent service
epochs, counter reset boundaries and missing coverage in comparisons.

Capture fixed host cgroup/available/swap/pressure metrics, aggregate Redis clients
and memory, fixed runtime reports, readiness/lag enums and catalog-only PostgreSQL
storage/activity reports. Keep local artifacts private and exclude identifiers,
env, raw health/log/client-list output, SQL and message/media content. Compare warmed
roles at comparable traffic and media schedules. Require at least one day before
forecasting, and several representative peak/RDB/release cycles before a VM change.
PostgreSQL file cache is reclaimable OS cache, not application heap; do not drop it.

Rollback through the typed wrapper on new readiness failures, lease loss, duplicate
effects, missed deadlines, unexpected failed/ambiguous work, OOM events or sustained
latency regression. Reduced connections or copies are structural improvements;
particular GiB or tariff savings require measurements. Historical storage changes
remain gated by backup/restore capacity, not silently performed during this rollout.
