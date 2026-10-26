# Independent Lastik rollout

Lastik (`eraser`) is a separate image, webhook receiver and worker. Its PostgreSQL,
Redis, queue, policies, compact deletion journals and history cursors belong only to
Lastik. It is not a fifteenth shared API role. Moderation only changes authenticated
settings and delivers protected publication references.

## Prerequisites and bootstrap

Require exact-SHA `Required` and `Analyze JavaScript and TypeScript` success. Inspect
live REG.RU headroom before provisioning: the initial budgets are 1 CPU/512 MiB for
Lastik, 1 CPU/1 GiB and 256 MiB shared memory for its PostgreSQL, and 0.5 CPU/256 MiB
for Redis. These limits do not authorize changing sibling projects or increasing MAX
quotas. Preserve the 10 GiB API rollout disk floor when API changes are included.

The new storage roots are `/mnt/maxim-cold/runtime/eraser/postgres` and
`/mnt/maxim-cold/runtime/eraser/redis`. Bootstrap refuses a missing cold mount. It starts
only these new stores; routine application deployments never recreate them. Lastik's
stores require their own independently replicated backup and restore acceptance before
treating persistent recovery as verified; the shared RAID is not an independent backup.

After synchronizing exact green tooling with the normal `deploy main --plan`, prepare
an owned private `0600` JSON file outside Git containing `sourceSha`, `botId` and
`botToken`. The SHA must match that checkout. Pass its path without exposing contents:

```sh
./infra/scripts/vps-connect.sh eraser-bootstrap /absolute/private/lastik-request.json
```

Bootstrap writes `/var/lib/maxim-secrets/eraser.env` and
`/var/lib/maxim-secrets/eraser-postgres-password`. Only Lastik receives its bot token.
The permanent `/var/lib/maxim-deploy/eraser-reader-version` floor is installed before
any takeover can be enabled; neither disabling availability nor removing a credential
permits an older API reader. The canonical `.env` receives only `ERASER_ENABLED=true`, the internal control URL and
its separate authentication key. Existing chat periods remain available for import;
Lastik policies default off until the human administrator explicitly enables them.
A partial installation preserves files and fails closed. `eraser-bootstrap --stores-only`
may finish an interrupted store startup with those same secrets; it does not rotate them.
Credential rotation needs a separately reviewed procedure.

## Deploy and connect

```sh
./infra/scripts/vps-connect.sh deploy main --auto
```

The planner selects the independent `eraser` component. It builds/reuses immutable
`maxim-eraser:<full-sha>`, verifies secret/storage readiness, runs its additive migrations,
recreates only the application, and checks `/health` against the exact component SHA and
both own stores. The ordinary release manifest records the image ID/source SHA. Before
bootstrap, legacy three-component manifests remain valid. Once installed, inherited
Lastik image identity is checked on later partial deployments.

Apply the reviewed canonical nginx site through the existing manual site procedure;
`nginx -t` must pass before reload. Only `POST /eraser/webhook` is forwarded to Lastik
on loopback port 3005; internal control routes are never public. Then register and read
back the exact bot's authenticated HTTPS subscription:

```sh
./infra/scripts/vps-apply-major-site.sh --dry-run maxim-vps
MAXIM_APPLY_MAJOR_SITE_CONFIRM=1 ./infra/scripts/vps-apply-major-site.sh maxim-vps
./infra/scripts/vps-connect.sh eraser-webhook
```

Review the dry-run diff before application, preserving the current sibling routes and
snippets. The canonical file is `/etc/nginx/sites-available/major-maksimov.ru.conf`,
enabled by `/etc/nginx/sites-enabled/major-maksimov.ru.conf`; backups stay under
`/etc/nginx/backups`. The apply operation holds the shared deploy lock through local
route verification and any rollback, using a private staging directory per invocation.

This operation sends no chat messages. Add Lastik to a designated group with read-all
and delete/write administrator privileges. The moderator settings retain the switch
and the 24-hour, 48-hour, or 168-hour period. Activation requires the exact Lastik
rights, synchronized protection references, and the persisted legacy ownership fence.
Never bypass a pending old uncertain deletion or send work back to a moderator.

Cold source recovery installers capture the independent control URL and authentication
key from the stopped generation into their existing private environment. Before the
source database commit they require durable Lastik exact-message holds; legacy recovery
also installs global author holds. A shared database fence prevents an earlier final
deletion decision from escaping this check. An unavailable service or matching
dispatching/uncertain journal refuses installation. Additive holds survive that refusal:
reconcile the exact journal before continuing, without deleting holds or blindly
repeating an uncertain operation. The Lastik bot token never enters these clients.

## Acceptance and rollback

Verify availability, deletion and protected exceptions separately using only uniquely
marked agent-created messages in the authorized test group. Keep the production release
SHA/image ID, completed checks and any missing coverage distinct. Do not age or delete
pre-existing messages for a live test. A 100-million-message backlog is a gradual job:
the initial 20 total HTTP requests/second also pays for reads/checks/retries, and each
chat has at most one Lastik deletion/second.

An immutable `rollback-release <release-id> eraser` selects only Lastik's recorded
application image. It never restores or recreates either store. API rollback must retain
the installed Lastik ownership reader even when its availability flag is disabled.
Stopping Lastik blocks new deletions, but an already sent request can finish; preserve
its journal for reconciliation. Do not clear the queue or invent successful receipts.
