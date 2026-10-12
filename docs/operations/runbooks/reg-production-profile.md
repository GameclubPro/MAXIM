# REG.RU production profile

MAXIM runs on the REG.RU dedicated server. The repository's `vps-*` command names remain
stable interfaces; they do not mean production is still a virtual machine. This profile is
the starting point for capacity and operational work. Verify live inventory before mutation.

## Host and access

| Item               | Production baseline                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| SSH                | `maxim-vps` → `maximadmin@89.108.122.76`, strict host-key verification      |
| MAXIM checkout     | `/var/www/Chat_bot`                                                         |
| CPU                | Xeon W-2265, 12 physical cores, 24 hardware threads                         |
| Memory             | 64 GB installed; Linux reports about 62.5 GiB                               |
| Storage            | 2 × 2 TB NVMe, RAID1; usable capacity is one drive, not their sum           |
| Root/Docker        | LVM root on `md1`, about 1.8 TiB filesystem capacity                        |
| Cold storage       | `/mnt/maxim-cold`, about 590 GiB loop-backed filesystem on the same RAID    |
| Capacity sensor    | `MAXIM_MONITOR_CAPACITY_BLOCK_DEVICE=md1`                                   |
| MAXIM entry points | `major-maksimov.ru/app/`, `/api/`, closed `admin.major-maksimov.ru`         |
| Other projects     | Svyazka (`/var/www/svyazka`) and Karavan (`/var/www/max-delivery-platform`) |

Use ignored `.env.vps`, based on `infra/env/vps.env.example`, for local key paths and connection
settings. Keep `MAXIM_VPS_AUTO_AUTHORIZE_SSH=0` and `MAXIM_YC_*` VM/security-group settings unset
there. Yandex SSH authorization and `yc-shell` are legacy tools, not REG.RU recovery. Diagnose
SSH using the current destination, provider firewall, host UFW/sshd and REG.RU console/IPMI.

`maxim-vps-yandex-retired` is for inspecting the former source only. REG.RU is the sole writer.
Do not resume old application containers or roll back to the old database: recover from current
REG.RU data and compatible immutable releases. Shared DNS and Karavan cloud routes have their
own migration scope; MAXIM operations do not authorize their removal.

## Storage and backup boundaries

Keep the production stateful named volumes and their existing bind driver options under
`/mnt/maxim-cold/runtime`. Docker must retain its mount dependency and mountpoint startup check.
Never accept a Compose prompt to recreate these volumes, and never start/recreate PostgreSQL
or Redis as a side effect of an ordinary application deploy.

The root filesystem, loop backing file, cold filesystem and RAID are nested capacity budgets.
Check free space on **both** root/Docker and cold before copies, restores or large maintenance.
Do not add their reported free space as independent capacity. `md0` is the boot RAID; `md1`
is the workload RAID. Both mirrors should report `[UU]` before heavy maintenance. Monitoring
`md1` captures the shared device's activity, but is not a benchmark of NVMe throughput or proof
that each member is healthy.

Local backup paths remain `/mnt/maxim-cold/backups/maxim` and
`/mnt/maxim-cold/restore-smoke/maxim`. They share the production failure domain. Independent
encrypted backups use REG.RU S3; a copy on the cold filesystem does not replace them. Keep
backup/restore timers disabled until their actual producer, independent copy verification,
capacity bounds and isolated restore have passed. A verified migration snapshot does not
establish recurring backup coverage.

## Using the larger host

Ordinary API roles, PostgreSQL and Redis have no host-wide 8-CPU/24-GB ceiling in the production
Compose file. They already use the larger host's CPU and memory/cache as demand grows. The
following limits are separate application budgets, not the former server's size:

| Budget                         | Current setting / rule                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| API database pools             | 72 main connections across 14 roles, plus 6 admin read connections                      |
| Enqueue                        | Pool 24, queue concurrency 32; 12 shared preparation slots with per-bot/class admission |
| Native OCR and photo sandboxes | Each 1 CPU / 1 GiB; preserve exact isolation and native identity                        |
| Media analysis                 | 1 CPU / 1 GiB                                                                           |
| Message retention              | 0.5 CPU / 512 MiB, pool 2; feature activation has its own gates                         |
| MAX API requests               | Existing global, priority and per-chat rate limits remain independent of CPU            |

Keep the current worker/pool budgets until a measured bottleneck justifies a specific change.
More workers can exhaust PostgreSQL connections or cause extra MAX retries. Leave headroom
for both sibling projects, Linux page cache, backups and one build/restore operation; do not
schedule simultaneous heavy builds because RAM happens to be available.

PostgreSQL's migrated configuration starts with `max_connections=100`, `shared_buffers=128MB`,
`effective_cache_size=4GB`, `work_mem=4MB`, `maintenance_work_mem=64MB` and `max_wal_size=1GB`.
These are the migration baseline, **not a tuned 64-GB database profile**. Confirm effective
settings before any change. In particular, Linux page cache benefits the database even with
small `shared_buffers`; `effective_cache_size` is a planner estimate, not an allocation.
`work_mem` can multiply per plan node and parallel worker, not just per connection. The
container's 512 MiB `/dev/shm` is dynamic shared memory, separate from the main buffer pool.

Treat database buffer/checkpoint/planner tuning as its own measured change. A
`shared_buffers`/connection ceiling change needs PostgreSQL restart planning, current recovery
evidence and orderly application quiescence; do not smuggle it into an API deploy. Preserve
the current pools, queue ordering, receipts and native caps while measuring that change.

## Capacity checks and acceptance

Start with the normal bounded tools:

```bash
./infra/scripts/vps-connect.sh doctor
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh monitor-readonly 600 120
./infra/scripts/vps-connect.sh postgres-audit activity
./infra/scripts/vps-connect.sh postgres-audit storage
./infra/scripts/vps-connect.sh postgres-audit webhook-cohort
```

Run catalog audits sequentially. Storage reports use the restricted audit session: its forced
`work_mem` and disabled query parallelism do not describe application sessions. Never replace
them with arbitrary live SQL or unbounded whole-table scans.

Compare equal, representative windows before/after one change: ingress/admin readiness,
automatic system mode, fresh closed receipt cohorts and action outcomes, queue age,
database waits/pool pressure, CPU/iowait, memory available, swap-in and disk queue/utilization.
The monitor archives hardware-thread count (24), not physical cores (12). Low normalized load
alone does not prove single-threaded workers have capacity. Preserve gaps and truncated samples;
a quiet short window is not a peak-throughput test or authorization to raise MAX API limits.

Use the normal exact-SHA CI and scoped deployment flow for runtime changes. Keep source host
retirement, shared-volume identities and sibling services outside every MAXIM rollout.
