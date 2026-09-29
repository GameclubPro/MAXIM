# Watched primary backup

The local wrapper runs the existing encrypted stream helper under an independent
health/queue watchdog. It creates no backup file on the VPS and acquires the
existing shared deployment lock for the dump. It is an attended maintenance
path, not an unattended primary backup schedule.

```bash
node infra/scripts/watch-live-postgres-backup.mjs \
  --local-dir /absolute/private/encrypted-backups \
  --age-recipient-file /absolute/private/recipients.txt \
  --age-identity-file /absolute/private/age-key.txt \
  --rate-limit 10485760 --max-duration-sec 14400
```

Before launch and every 15 seconds, one bounded probe reads root free space and
the local ingress/admin readiness endpoints. It aborts on missing/malformed/stale
data, readiness loss, raw queue failure (even within readiness hysteresis), queue
lag at least 10 seconds or root reserve below 4 GiB. This is an abort threshold,
not the 40 GiB operating-capacity target. Probe time is capped at 25 seconds and
response size at 64 KiB. Only fixed failure labels are emitted; health payloads
can contain identifiers and must not be archived.

On failure the process group receives TERM; the stream helper terminates its
uniquely named PostgreSQL backend and removes its temporary output. A 45-second
deadline bounds local cleanup. After a failure, check `postgres-audit activity`
and readiness before any retry. Do not automatically restart a failing dump or
bypass the deployment lock. Operator INT/TERM follows the same stop path. A
machine failure/SIGKILL cannot guarantee cleanup: use the audit before recovery.

The encrypted archive, full-stream hashes and `pg_restore --list` checks are not
a restore test. Before destructive maintenance, restore into an isolated local
PostgreSQL 16 database with no application workers or MAX credentials, validate
the relevant schema/data invariants, and budget its full physical size. Leave
existing verified backups intact until this gate succeeds.
