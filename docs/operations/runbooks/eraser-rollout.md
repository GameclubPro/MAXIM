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
A connection request is a separate explicit administrator action. It retains the selected
period (24 hours, 48 hours or 1 week) while deletion remains disabled, and expires
after its one-hour connection window. Lastik checks its own rights and activates the exact
pending request independently of moderator availability. Ordinary settings writes cancel
the previous pending request; expiry, cancellation and lost responses never imply activation.

The additional permanent `/var/lib/maxim-deploy/eraser-connection-request-version` floor is
`1`. Bootstrap and the normal locked application deploy install and synchronize it before
new API/Lastik writers or `0003-connection-requests.sql` can run. The original ownership
floor stays `1`; neither marker may be removed or lowered when availability is disabled,
the queue is empty, or all connection requests have expired. Unknown, partial or unsafe
marker files fail closed. Both API rollback paths retain the connection-aware contracts,
operation canonicalization and controller tooling. An Eraser-only immutable rollback also
requires the exact target's pending-request, expiry and cancellation reader before startup.
Static-only immutable rollback retains its component scope. Ref synchronization and
rollback tooling bootstrap must preserve this floor before replacing the checkout.
A separate permanent `/var/lib/maxim-deploy/eraser-rate-limit-reader-version` floor is
`1`. A selected Lastik deploy installs it before `0005-durable-rate-limit.sql` and
application startup. Both the worker and webhook-registration client read the exact
bot's PostgreSQL cooldown before MAX admission. An immutable Lastik rollback requires
that reader; API/static image-only rollback retains its scope, while checkout replacement
must preserve the enforcing tooling. Disabling availability never lowers this floor.
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

## Due scheduling and control scans

Migration `0006-due-scheduling.sql` stores future arrivals in hourly rows with a
60-bit minute bitmap, without creating a candidate for every young message. Repeated
arrivals within a minute reuse its bit. A known minute becomes due at its end plus the
selected retention period; this batching adds at most one minute before scheduling,
not a bound on queue or MAX delay. An already-due arrival wakes the chat immediately.
Expired hour rows are compacted in bounded batches into a durable live continuation
under the policy lock before removal. A completed page clears only wholly covered
minutes. Partial minutes and a repeated full 100-message timestamp boundary remain
unresolved; they never authorize skipping a millisecond or declaring coverage complete.

Ordinary scheduling takes the nearest candidate deadline, known future minute or
unfinished eligible scan. Candidate eligibility is the later of the current policy's
age threshold and the existing `next_attempt_at` retry/pin deadline. Indexed selection
for each supported period takes at most five candidates per visit, preferring live
work to history. Changing the period does not turn a retry deadline into an age wait
or make an uncertain DELETE eligible. Young, never-issued candidates can return to
compact ranges when their retained deadline permits it. Page completion and visit
completion recheck durable state under the same policy lock used by ingress; an old
visit cannot overwrite a newer webhook wakeup.

Known due work and control scans have independent durable windows and cursors. A new
due message cannot convert an unfinished control scan to the ordinary request budget,
and completing its narrower window cannot certify the broader coverage. A late receipt
inside an open control window invalidates that window's older page; a receipt outside
it preserves the cursor. An ambiguous full control-page boundary retains its gap and
requests another control attempt after six hours, within the same shared budget.

The shared cleanup queue has 64 fixed slots: 62 for ordinary due work and two for
control scans, with the existing global concurrency of eight workers. Control scans
visit only the live window. Their rights and page requests share one aggregate HTTP
request/second across replicas and also consume the total MAX request budget. Scan
continuations keep that purpose; eligible deletions discovered by a control scan use
the ordinary budget and the same final guards. Rights evidence may be reused within
a visit, retaining its original request-start timestamp and 30-second lifetime; pin
evidence still expires after five seconds. Short admission waits remain within a
visit, while a long cooldown releases the worker and preserves a durable retry time.

Completed empty control windows request the next control scan after 15, 30, 60, 120,
240 and then 360 minutes; a nonempty completion resets the desired interval to
15 minutes. These are desired intervals, not coverage guarantees. With 20,000 empty
chats, one rights read plus one page per chat already requires at least 40,000 seconds
(11 hours 6 minutes 40 seconds) at one request/second. Extra pages, retries and other
delays extend that time. The durable `last_live_completed_at` records actual completed
control windows; a missing timestamp means no recorded completion. Ordinary due work,
partial pages and blocked windows do not refresh it. This timestamp is not yet exposed
by the runtime diagnostics response, so that response's existing fields cannot prove
control-scan coverage. Retained gaps outside a completed window remain separate from
its completion time.

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
Keep uncertain journals across restarts without replaying the DELETE. They cause no
automatic presence reads or scheduled retries; independent eligible messages continue
through fresh rights, pin and policy checks. A diagnostic read cannot settle an unknown
effect. Authentication failures and rate limits stop the current visit.
An issued attempt settles only its exact dispatch ID. Stale pending decisions cannot
reopen, protect or confirm an issued journal; a rejected 429 permits a fresh guarded
attempt only after its deadline. Any failed DELETE ends that visit after recording its
outcome, preventing a cascade of uncertain effects. Final dispatch checks the database
clock after lock waits, and removal ingestion uses the same policy-before-candidate
lock order as dispatch and settlement.

A received 429 stays a known rejection even when Redis cooldown persistence fails.
Its token-wide deadline is also stored in PostgreSQL and survives client restart; failed
durable admission stops new requests. The 200-candidate cap applies to new pending
intake, separately from issued, uncertain and review journals. A late exact rejected
attempt keeps its retry even if it temporarily fills an extra pending slot; further
intake waits for space. A known rejection arriving after its visit restores its own
retry wakeup. Shortening a period recomputes age eligibility while preserving pin,
rate-limit and unknown-effect waits; new age deferrals never replace those deadlines.
An authenticated removal receipt that frees pending capacity recomputes the schedule
so already-due work can resume. Operator retry accepts only the exact never-issued
review intent under its current policy revision and activation, and saves its wakeup
in the same transaction. Preserve the review response's complete timestamp when
submitting that request; truncating its PostgreSQL microseconds fails the identity check.

Startup keeps authenticated webhook ingress available while a known 429 defers
subscription verification. Workers remain stopped and health remains not ready until
identity and subscription checks succeed. Shutdown cancels the wait; other prerequisite
failures remain fatal. A deployment still requires the normal readiness deadline.

`/health` also requires both workers to be ready and running and reports bounded worker
progress diagnostics. Occupied slots older than 120 seconds or an unrecovered worker
error close readiness even when scheduler ticks continue. Healthy idle workers require
no completed job or MAX probe. These observations do not establish successful deletion.

Migration `0004-scan-generation.sql` adds a cursor generation with a constant zero
default; it does not change activation or existing effect journals. A late webhook or
protection rewind invalidates an older page, including an empty response. New messages
outside the due window do not invalidate it. Preserve these rules when changing scans.
The authenticated `/internal/v1/runtime` page includes `diagnostics.lastError`,
`historyBoundaryBlocked`, `awaitingCurrentProtection` and `awaitingHistoricalProtection`.
The closed Safety Desk forwards these optional flags and allowlisted error reasons;
unrecognized errors become `unknown`, and older runtimes keep diagnostics absent
rather than implying clean flags. These fields grant no retry or mutation authority.
They stay outside ordinary settings responses; `blocked` alone is
not a reason to discard protection or replay a DELETE. See the
[27 October audit and regression plan](../plans/2026-10-27-lastik-deletion-audit.md).

Live acceptance records deletion acknowledgements separately from any unavailable
absence readback and preserves its exact operation journal.

An immutable `rollback-release <release-id> eraser` selects only Lastik's recorded
application image. It never restores or recreates either store. API rollback must retain
the installed Lastik ownership reader even when its availability flag is disabled.
The due-scheduling migration is additive and introduces no new reader floor. Native
scheduling writes keep the finite legacy `next_run_at` projection of ordinary and
control-scan deadlines and a conservative `live_floor` covering unfinished work from
both windows. A narrow trigger recognizes older writers that change only `next_run_at`.
It preserves their active cursor and routes unclassified discovery back to the control
scan after a forward upgrade. The transaction-local `eraser.native_schedule` marker
prevents native projection repairs from being mistaken
for legacy work. Preserve this compatibility contract, the original retry deadlines and
all existing ownership, connection-request and rate-limit floors. A compatible older
image can resume its earlier polling and automatic diagnostic reads: the adaptive
schedule and separate one-request/second control-scan budget apply only to images
implementing this stage. Rollback does not establish those efficiency guarantees.
Stopping Lastik blocks new deletions, but an already sent request can finish; preserve
its journal for reconciliation. Do not clear the queue or invent successful receipts.
