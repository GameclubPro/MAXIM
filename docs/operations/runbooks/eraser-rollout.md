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

Nginx and subscription tooling may advance without rebuilding Lastik. Both operations
check the installed Lastik source against its component in the complete active release
manifest under the protected deploy lock.

Add Lastik through its patch-only nginx command after synchronizing the exact green
tooling SHA. It inserts only the owned upstream and `/eraser` routes into the current
canonical site; existing host-managed includes, headers, request limits, buffering and
sibling routes retain their exact bytes. Only `POST /eraser/webhook` reaches Lastik on
loopback port 3005. Then register and read back the bot's HTTPS subscription:

```sh
./infra/scripts/vps-connect.sh eraser-nginx
./infra/scripts/vps-connect.sh eraser-nginx --apply
./infra/scripts/vps-connect.sh eraser-webhook
```

Review the preview diff before application. Unknown anchors, conflicting or partially
modified Lastik blocks fail closed; exact installed blocks are idempotent. The fixed
canonical file is `/etc/nginx/sites-available/major-maksimov.ru.conf`, selected by the
unchanged `/etc/nginx/sites-enabled/major-maksimov.ru.conf` symlink. Backups stay under
`/etc/nginx/backups`. The shared protected deploy lock covers live identity checks,
atomic replacement, `nginx -t`, reload and localhost/SNI checks: a wrong-secret POST
must return Lastik's 403, and internal paths must return 404. These probes send no MAX
messages. Reload readiness allows five complete namespace checks with one-second pauses;
each retry rechecks installed bytes and the enabled link. Failed observations retain
bounded private evidence and report the path, assertion, HTTP status and transport exit.
Rollback restores only the invocation's own installed bytes; observed external
changes refuse rollback and preserve its backup and private evidence directory. The
full-site setter remains available for separately reviewed whole-site changes and is
not the Lastik installation path.

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

MAX documents an exact-message `404` as either missing or inaccessible. Neither
`not.found` nor `message.not.found` certifies absence. Only a positive DELETE
acknowledgement or an authenticated `message_removed` receipt settles deletion.
Keep uncertain journals across restarts without replaying the DELETE. Failed message
reads defer that journal while other eligible messages continue through fresh rights,
pin and policy checks; authentication failures and rate limits stop the current visit.
Live acceptance records deletion acknowledgements separately from any unavailable
absence readback and preserves its exact operation journal.

An immutable `rollback-release <release-id> eraser` selects only Lastik's recorded
application image. It never restores or recreates either store. API rollback must retain
the installed Lastik ownership reader even when its availability flag is disabled.
Stopping Lastik blocks new deletions, but an already sent request can finish; preserve
its journal for reconciliation. Do not clear the queue or invent successful receipts.
