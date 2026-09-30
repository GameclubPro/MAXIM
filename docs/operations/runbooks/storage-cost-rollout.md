# Storage and bot cost rollout

This first runtime stage reduces delete-lease writes, bounds the local chat-context
cache and skips unchanged VK import updates. It adds fixed runtime counters and
trusted-main CI layer reuse. It does not activate historical body/media expiry,
receipt deletion, database rewrites or notice-upload token reuse. See the
[full plan](../storage-and-bot-cost-optimization-plan-2026-10-01.md).

## Release and observation

Run the scoped checks and require green `Required` and `Analyze JavaScript and
TypeScript` CI checks for the exact source SHA. Deploy through the normal wrapper;
any API role selection expands to all 14 shared-image roles, including Publisher
and message retention. The queue ownership/pause fence, immutable image identity,
OCR sandbox attestation and strict smokes remain mandatory. Do not recreate
PostgreSQL or Redis. If local build capacity is insufficient, use the existing
verified exact-SHA CI image preload; do not lower the 20 GiB API build floor.

```bash
./infra/scripts/vps-connect.sh deploy main --plan
./infra/scripts/vps-connect.sh deploy main api-admin
./infra/scripts/vps-connect.sh postgres-audit storage
./infra/scripts/vps-connect.sh exec df -B1 / /mnt/maxim-cold
./infra/scripts/vps-connect.sh exec docker compose -f infra/docker-compose.yml exec -T api-admin node apps/api/dist/apps/api/src/scripts/audit-storage-runtime.js
```

The built `audit-storage-runtime` CLI requires the existing admin role and accepts
no arguments. It reads only the fixed Redis metric keys, starts no Nest workers,
makes no MAX or PostgreSQL calls, and prints allowlisted scalar JSON. The closed
system-admin endpoint is `GET /api/v1/system/metrics/storage-runtime`. Reports
publish every 30 seconds and expire after 90 seconds; collect after the first
publication. Missing, malformed, stale or unavailable reports are missing
coverage, not zero work. Reporting failure must not block bot work.

Keep saved snapshots owner-private. Retain only fixed service names, epochs,
numeric metrics and fixed readiness/condition enums. Full ready responses and
monitor logs may contain identifiers; archive only their allowlisted readiness,
numeric queue lag and fixed state. Do not save env, tokens, message/media payloads,
free-form errors, SQL, chat/user/bot IDs or arbitrary labels. The existing
`monitor-readonly` capacity archive already performs its own stricter sanitization.

Compare runtime counters separately for each service with the same `startedAt`;
any counter decrease invalidates that counter's interval. PostgreSQL restart,
database-statistics reset and WAL-statistics reset have independent boundaries.
Report gaps explicitly and normalize work by comparable traffic. Require at
least one day of comparable coverage before extrapolating capacity or savings;
queue-lag percentiles are not API/action response latency. Cache bytes estimate
retained data, not RSS. VK rows-written counters describe statement activity,
not committed transactions; skipped rows also include publication fences.
Table totals already include indexes and TOAST: never add them twice.

## Release-image reclaim

For a separately reviewed maintenance preview, use the same deploy lock and the
manifest-aware tool with the five-release floor explicitly set:

```bash
./infra/scripts/vps-connect.sh exec bash -c '
set -euo pipefail
source infra/scripts/lib/deploy-lock.sh
acquire_deploy_lock
node infra/scripts/release-image-reclaim.mjs reclaim \
  --state-dir /var/lib/maxim-deploy --until 168h \
  --minimum-retained-releases 5 --dry-run
'
```

Review the candidates, then repeat that same locked invocation with only
`--dry-run` removed for apply. The tool rechecks current/retained manifests and
all container references immediately before deletion. It removes only unused
old immutable MAXIM image refs. It preserves all retained releases, containers,
volumes, shared build cache and sibling-project images. Displayed image sizes
do not predict physically reclaimed bytes; compare `df -B1 /var/lib/docker`
before and after.

An optional normal-deploy hook uses that fixed seven-day cutoff and minimum five
distinct retained release IDs:

```bash
MAXIM_DEPLOY_RECLAIM_OLD_IMAGES=1 ./infra/scripts/vps-connect.sh deploy main api-admin
```

It is off by default, runs under the held deploy lock only after a newly committed
successful release and all strict smokes, and reports filesystem bytes. A reclaim
warning leaves the successful release valid; inspect it and rerun preview before
retrying cleanup. Do not retry a deployment solely because optional reclaim failed.

## Gates for later stages

Historical UPDATE/DELETE/DROP, retention activation and physical rewrites require
a fresh encrypted full backup, verified checksum, complete isolated PostgreSQL 16
restore, replay/receipt safety checks and sufficient maintenance capacity. The
[watched backup](watched-postgres-backup.md) is attended and readiness/queue/space
gated; an archive list is not restore proof. Budget a restore outside the production
root filesystem and leave existing verified backups until the new chain passes.
A logical restore measures compact restored size; it does not measure production
bloat. Deletion/ordinary VACUUM does not guarantee filesystem space recovery.

Deferred notice-upload reuse requires both the current send-owner fence and the
exact bot plus immutable asset identity (content digest/version). Invalidate only
the exact rejected token with CAS after a definitive documented media-token 4xx
rejection, then reacquire the upload lease; a concurrent newer token must survive.
Do not reuse tokens across bots or retry an ambiguous send/timeout/5xx as a token
failure. Other 4xx statuses do not automatically authorize reupload. These
requirements describe a future change; this rollout does not activate that cache.
