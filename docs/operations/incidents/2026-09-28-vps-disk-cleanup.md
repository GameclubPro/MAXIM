# VPS disk cleanup, 2026-09-28

The owner requested removal of unnecessary files from the VPS. This maintenance
followed the earlier disk-full incident; its nine-image reclaim is not counted
again here.

## Result

- Root filesystem available bytes increased from `6,320,488,448` to
  `12,402,864,128`: approximately 5.7 GiB net recovered, with 11.6 GiB available.
  These are live filesystem observations; application writes continued throughout.
- The cold backup filesystem remained unchanged at approximately 208 GiB free.
- No application, PostgreSQL or Redis container was stopped or recreated.
  No database rows, volume contents, backups, secrets or release manifests were removed.

## Reviewed cleanup

1. Removed four closed Node.js crash dumps from `/var/lib/apport/coredump`,
   totaling `3,577,384,960` logical bytes. `fuser` found no open references.
   The latest observed dump from 2026-09-28 was retained for diagnosis.
2. Vacuumed archived system journals older than seven days with
   `journalctl --vacuum-time=7d`; journald reported 149 MiB reclaimed. The final
   journal footprint was 274.3 MiB, including active journals.
3. Removed only compressed nginx log archives older than seven days. Active logs,
   the uncompressed previous rotation and recent compressed archives were retained.
4. Ran `apt-get clean` and removed the two unused regenerable APT binary caches
   (`pkgcache.bin`, `srcpkgcache.bin`, about 116 MB total). Installed packages and
   repository lists were preserved. Simulated autoremove found no removable packages.
5. Reviewed all 243 BuildKit records. All were reclaimable, with no active cache
   use. Selected exactly 34 records with `Shared=false`, last used at least
   24 hours earlier. Under the shared deployment lock, re-read their ownership/use
   flags and usage counters before pruning an anchored allowlist of those IDs,
   also retaining the `until=24h` filter. Docker reported 2.207 GB reclaimed.
   Image IDs and tags were identical before and after this operation. The remaining
   209 cache records were shared with images; Docker reported zero reclaimable
   build-cache bytes afterward. This was a bounded cache maintenance operation,
   not a host-wide image/container/volume prune or a change to retention defaults.

The manifest-aware MAXIM image preview with a 24-hour cutoff found no additional
candidates. Six current/retained manifests protected nine image identities/refs.
Sibling application release images and stopped legacy installations were preserved;
an unused Docker object alone is not proof that its data or rollback version is disposable.

## Verification and remaining capacity

- Docker retained 44 images, 34 containers (30 running), and 20 volumes.
- Redis reported `rdb_last_bgsave_status=ok`, `rdb_bgsave_in_progress=0` and
  `aof_last_write_status=ok`.
- Publisher status passed:
  `env=true runtime=exact pause=missing heartbeat=fresh/true secrets=ready`.
- At 15:57:29 UTC, database/Redis checks were true and the action window had
  951 successes out of 951 operations. Readiness still failed because the pre-existing
  webhook backlog was approximately 2,328 seconds old. This cleanup did not establish
  complete queue or historical-publication recovery.
- The dominant storage category remains the PostgreSQL data volume, approximately
  241 GiB in the earlier bounded filesystem inventory. Database files and named
  volumes were not treated as garbage. Free capacity still falls below the 20 GiB
  clean API build floor; disk expansion and a bounded database-growth investigation
  remain necessary. No disk-size or paid cloud change was made.
