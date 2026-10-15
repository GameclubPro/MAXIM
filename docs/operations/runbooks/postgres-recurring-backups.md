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
