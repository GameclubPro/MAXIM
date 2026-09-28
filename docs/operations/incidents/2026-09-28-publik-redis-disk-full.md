# Publik unavailable after root disk exhaustion, 2026-09-28

## Confirmed cause

At 15:32 UTC the production root filesystem had approximately 82 MiB available
and reported 100% use. Redis repeatedly failed its RDB background save with
`No space left on device`. Its `stop-writes-on-bgsave-error` protection rejected
queue and heartbeat writes with `MISCONF`. The Publisher container was running,
but its heartbeat was absent. Ingress and admin readiness returned 503;
PostgreSQL was reachable and Redis readiness was false. The sampled oldest
webhook lag was approximately 1,455 seconds.

Read-only filesystem inventory attributed approximately 241 GiB to the MAXIM
PostgreSQL volume, including 240 GiB in `base` and 961 MiB in WAL. This identifies
the dominant storage category, not a particular table or a proven growth cause.
The separate cold backup filesystem had free capacity; its backups were not
part of the cleanup.

## Recovery

The default seven-day manifest-aware image reclaim preview found no candidates.
A separately reviewed 24-hour preview found nine unused immutable MAXIM images
outside all six current/retained manifests. Those manifests protected nine
image identities and references. The existing guarded tool was then applied:

```bash
./infra/scripts/vps-connect.sh exec './infra/scripts/vps-docker-space-reclaim.sh --dry-run --until 24h'
./infra/scripts/vps-connect.sh exec './infra/scripts/vps-docker-space-reclaim.sh --until 24h'
```

The shorter age cutoff does not relax manifest or container protection. It is an
incident-specific operator choice, not a change to the default retention period.
Application containers, PostgreSQL, Redis, volumes, backup files, shared build
cache, and sibling application images were preserved. Redis persistence and
write protection were not disabled. Historical publication rows and attempted
send receipts were not reset or replayed.

## Capacity follow-up

Image reclaim provides immediate headroom but does not resolve ongoing database
growth. The owner selected recovery without increased infrastructure charges. Paid disk
expansion is outside the approved scope; a separate operator is handling storage
cleanup. The existing `disk_free_40gib` capacity alert and
20 GiB API build floor remain applicable. Diagnose table/index growth through
the bounded audit catalog before proposing retention or storage changes; do not
delete database files or run an emergency full-table rewrite.

## Verification

- Reclaim removed the nine previewed images; the root filesystem then had
  approximately 6.1 GiB available (`6,509,195,264` bytes in the next sample).
- Redis completed its existing background save at 15:36:49 UTC without restart
  or configuration changes. `rdb_last_bgsave_status=ok` and
  `rdb_bgsave_in_progress=0` were confirmed afterward.
- Publisher status recovered to
  `env=true runtime=exact pause=missing heartbeat=fresh/true secrets=ready`.
- The first recovery monitor sample confirmed all 14 API roles running on their
  exact release images, the queue fence unpaused/unowned, and database/Redis
  checks true. Readiness still returned 503 because the accumulated webhook
  backlog was approximately 1,791 seconds old. A recovered heartbeat alone is
  not proof of a fully drained queue or delivery of every historical post.
- Existing restart counters included two for message retention and 103 for the
  OCR auxiliary; these predated this intervention and were not reset. No
  container was restarted by this recovery.
- The completed 15:37:40–15:40:40 UTC observation contained 12 capacity samples
  with complete coverage and no new restarts. Queue-fence and fleet checks
  passed throughout, but readiness remained degraded: oldest-queue lag ranged
  from 1,790.607 to 1,894.810 seconds. At 15:42:35 UTC it was 1,963.725 seconds.
  Scheduled materialization logs identified host load above the existing hard
  governor threshold; those protections were retained. Thus the incident's
  disk/Redis write block was recovered, but full publication service recovery
  was not established during this observation.
- A bounded post-save log sample from Publisher/action/enqueue contained no
  new `MISCONF` or disk-full errors. A bounded publication catalog read still
  showed expired bot-access evidence and historical failed/ambiguous deliveries;
  these were not treated as permission to replay. Publisher greeting jobs whose
  dispatch had already been claimed also retained their no-automatic-retry fence.
- Public mini app JavaScript/CSS returned 200, and closed admin/public API
  access guards retained their expected 401/404 responses.
- Local early preflight, documentation checks and diff whitespace checks passed.
  No runtime source change or application redeploy was needed for the confirmed
  disk/Redis failure.
