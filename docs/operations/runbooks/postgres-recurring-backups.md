# Recurring PostgreSQL backup verification

The guarded logical producer holds the deployment lock while reading the primary.
Its low-priority, rate-limited stream stops after repeated readiness degradation or
loss of the configured free-space reserve. The cold filesystem and its backing
filesystem are separate admission checks over the same RAID, not independent copies.
After a watchdog abort, retain the exact window, release identity and queue/IO evidence;
do not disable the guard or repeat the same attempt without explaining the change.
Failed readiness probes emit `backup_readiness_v1` with fixed failure categories and
numeric queue age/threshold scalars. HTTP failures remain failures even if their body
claims readiness. The diagnostic excludes event identities and free-form health detail;
retain the service journal because later healthy snapshots cannot reconstruct the abort.

The producer and isolated restore probe can observe one refresh after the exact
`stale-ready-fallback` warning, provided all other strict checks and numeric lag
bounds pass. The second request waits beyond the ordinary two-second readiness
cache and shares the original HTTP deadline. It must pass the unchanged strict
checks and carry a newer, non-future queue sample no older than five seconds.
Persistent fallback, missing evidence, real dependency/lag/HTTP failures and an
exhausted deadline still fail. Both the initial failed sample and any confirmed
refresh are logged without event identities or response bodies. The two-failure
watchdog and storage reserve are unchanged; never count a fallback as healthy.

The API treats the bounded queue-lag refresh as a required dependency, including
when a recent stale sample exists. It uses the same dependency budget as a cold
queue read (1,500 ms by default), within the unchanged 2,500 ms readiness build
deadline; optional dashboard diagnostics retain their separate short budget.
A refresh that completes after 250 ms must not repeatedly lose to that optional
budget on each cache-expired watchdog retry. An unchanged, failed or timed-out
refresh still carries the stale warning, and fresh excessive lag still fails the
strict backup checks. Do not increase cache ages or watchdog thresholds to compensate.

Install `infra/env/postgres-backup.env.example` as `/etc/maxim-postgres-backup.env`
(root, 0600). Use `/mnt/maxim-cold/backups/maxim` and
`/mnt/maxim-cold/restore-smoke/maxim`, and set the backing path to
`/var/lib/migration-storage`. Capacity admission reserves the full current database
size for a dump and 125% for a restore, in addition to the free-space floor. Replication
temporarily needs another dump-sized ciphertext file. Retention preserves the newest
completed dump; two-day local retention does not imply independent S3 retention.

Configure a dedicated MAXIM writer in `/etc/maxim-backup/rclone.conf` (0600) and
public age recipients in `/etc/maxim-backup/recipients.txt`. Never copy the private
decryption key to the producer. Use the existing private MAXIM REG.RU S3 bucket;
do not borrow Karavan/Svyazka credentials or alter their policies. Set
`MAXIM_BACKUP_REPLICATION_REQUIRED=1` only when this configuration is ready.

`replicate-postgres-backup.sh` verifies the original dump checksum, encrypts locally,
uploads to a content-addressed ciphertext object, reads the entire object back and
compares SHA-256. It publishes a small verification receipt only after a matching
readback. An interrupted upload or changed object has no verified receipt. The overall
replication deadline is six hours; transfers default to 16 MiB/s and preserve previous
objects. The temporary encrypted file is removed after completion/failure.
Use a reviewed bucket lifecycle for long-term retention; this helper never deletes
remote backups or historic object versions.

The restore service runs as root so that its exact disposable directory can be cleaned.
Pin `MAXIM_BACKUP_POSTGRES_IMAGE` to the production PostgreSQL image identity. The
disposable container has no network, two CPUs, 4 GiB RAM and a PID limit; no application
or MAX worker runs against it. The service holds the deploy lock, monitors production
readiness and both storage reserves, and has a 12-hour deadline. It restores the
checksum-verified local archive and verifies migration completion plus critical
webhook, authority, action-ledger and publication primary indexes. Its receipt describes
this schema check, not an end-to-end business exercise or a decrypted S3 restore.
An operator should also periodically decrypt a downloaded independent copy with the
off-host key and run a recovery rehearsal from that copy.

After both manual services and independent readback pass:

```bash
sudo systemctl start maxim-postgres-backup-health.service
MAXIM_ENABLE_POSTGRES_BACKUP_TIMER=1 \
MAXIM_ENABLE_POSTGRES_RESTORE_SMOKE_TIMER=1 \
  ./infra/scripts/vps-install-postgres-backup-timers.sh
sudo systemctl list-timers --all 'maxim-postgres-*'
```

The installer checks recovery evidence before enabling timers. Daily backup is at
03:20 (server timezone, with up to 20 minutes jitter); restore is Sunday 05:30 with
up to 30 minutes jitter. Check sibling schedules and actual elapsed times before
enablement: lock contention is not a successful new backup. Observe the first planned
run separately from manual acceptance.

The hourly `maxim-postgres-backup-health.timer` fails when verified independent
evidence exceeds 28 hours, a restore exceeds eight days, receipts are malformed/future,
or its bounded directory census is incomplete. This is an operational freshness gate,
not a promised application RPO/RTO; measure actual copy and restore durations first.
Inspect the failed service and journal through host monitoring. No external alert
destination is configured by this helper.

The receipt check uses bounded metadata reads and never contacts PostgreSQL, Redis,
MAX or S3. A valid historic receipt does not prove current object availability.
Do not enable timers merely because a dump file exists or an upload returned HTTP 200.

## Independent Lastik profile

Use `MAXIM_BACKUP_PROFILE=eraser` with the same producer, replication, restore,
health and timer installer. The default remains `maxim`; other profile names fail
closed. Select the profile per invocation, not in the shared environment file.
The profile fixes the service/user/database to `eraser-postgres`/`eraser`/`eraser`,
appends `/eraser` to the configured backup root, restore root and remote prefix,
and uses only `eraser_*.dump` archives and `maxim-eraser-postgres-*` systemd units.
Do not append the suffix to the base configuration a second time. The readiness
watchdog checks both the shared API and Lastik's live worker health. Both profiles
keep the same protected deploy lock and capacity floors.

Lastik units require the tracked `postgres-backup-profile.sh` capability file in
`ExecStartPre`. A checkout rollback predating profile support must fail each service,
including freshness health, before an old script can silently select the main database.
Keep this file with all profile-aware scripts; do not replace this failure with a
systemd condition that reports a successful skip. An image-only rollback leaves the
compatible host tooling in place.

The eraser restore verifies exact migration names and digests plus critical tables
and indexes, in a network-isolated disposable PostgreSQL container. Its receipt
contains `profile=eraser`, the schema digest and
`verification=isolated_restore_and_eraser_schema`. Main-database receipts never
satisfy Lastik's health gate. A schema restore does not prove application replay
safety, current remote-object availability or recovery from the independent copy.

Install the eraser units with both timer switches left off. After a guarded manual
backup, full encrypted remote readback and isolated restore have succeeded, run
`maxim-eraser-postgres-backup-health.service`. Only then enable this profile's timers
with the existing installer switches. Lastik defaults to daily 01:20 backup and
Sunday 02:30 restore (server timezone, the same jitter as the main profile).
Inspect actual sibling schedules and durations before enabling them. A skipped
locked run is not a fresh backup. The main profile's timer state is independent.

The local rehearsal is reproducible without MAX access:

```bash
node scripts/agent/with-test-stores.mjs -- \
  node --import tsx --test apps/eraser/test/recovery.stores.ts
```

It dumps and restores an isolated synthetic database, preserves unknown dispatch
identities, protections, future scheduling and durable Retry-After, then reconstructs
work in a fresh Redis namespace using a fake MAX transport. It cannot authorize
deletions after restoring an old production snapshot: stop execution, retain the
newer effect journals and reconcile the snapshot gap before admitting any effect.
Never bring a recovery worker online merely because schema checks passed.
