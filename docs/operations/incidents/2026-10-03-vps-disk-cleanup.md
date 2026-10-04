# VPS disk cleanup, 2026-10-03

The owner requested cleanup of the production VPS. This report describes the
server maintenance only.

## Result

- Root filesystem available bytes increased from `8,149,585,920` to
  `20,991,266,816`: approximately 12.0 GiB net recovered during live application
  writes. Root utilization decreased from 98% to 94%, with about 19.6 GiB free.
- The cold filesystem remained unchanged at `224,832,724,992` available bytes.
- No application container was started, stopped or recreated. PostgreSQL and
  Redis data, named volumes, backups, secrets and release manifests were not
  removed or modified by this maintenance.

## Reviewed cleanup

1. The normal manifest-aware image reclaim preview refused to proceed because
   `/var/lib/maxim-deploy/current.json` was absent. No image removal, manifest
   recovery or retention change was attempted.
2. Reviewed all 201 Docker Engine BuildKit records and selected 159 with
   `Shared=false`, `InUse=false` and exact `LastUsedAt` older than 24 hours.
   Docker Engine `/system/df` supplied raw sizes and timestamps; the installed
   Buildx JSON formatter instead supplied human-readable sizes and ages.
3. Under the shared deploy lock, checked for active builds, revalidated each
   selected record's identity, size, usage count and timestamps, and confirmed
   that native `buildx du` selected the exact anchored ID allowlist. Pruning used
   that ID allowlist plus `until=24h`, without a host-wide Docker prune. Docker
   reported 12.88 GB reclaimed. The final inventory contained 53 records:
   148 selected records disappeared, while 11 selected records remained.
4. Cleaned downloaded APT packages and the two regenerable APT binary caches.
   Removed five compressed nginx access/error archives older than seven days,
   totaling 184,950 bytes. Installed packages and current logs were preserved.
   Journal vacuum retained the seven-day window and reported no useful reclaim.
5. Preserved the latest Node crash dump for diagnosis. No unused container or
   volume was treated as disposable solely because Docker called it unused.

## Verification and limits

- The broad Docker metadata fingerprint changed during cache pruning. Follow-up
  inspection still found all 82 images, 34 containers, 30 running containers and
  10 volumes. Every container's start time preceded maintenance, and all restart
  counts were zero. Five retained manifests validated; all eleven distinct
  retained image refs resolved to their manifest image IDs.
- Ingress and admin liveness returned HTTP 200. Both readiness endpoints still
  returned HTTP 503 because of the webhook backlog already observed before
  cleanup; database and Redis checks remained true. This maintenance did not
  establish queue recovery or finalize the interrupted release.
- The deploy lock was released. Final capacity still fell slightly below the
  20 GiB floor required for a clean shared API image build; no deploy was run and
  no capacity guard was bypassed.
