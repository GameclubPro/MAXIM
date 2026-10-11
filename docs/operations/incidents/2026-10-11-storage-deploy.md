# Storage cleanup and bot release, 2026-10-11

All timestamps below are UTC. The final API release is
`b29d7f78990bb8f8f104849679eb5fc531a1f6c8`, recorded as
`release-20261011T083353Z-b29d7f78990b`. It fixes the confirmed local-rate-limit
handoff stall and passed the sustained fifteen-minute queue-readiness window.
Static components retain `6a9d67fcae74d037855d8bda98197c3e54f5818d`.
The sampled FAILED receipt, OCR timeouts and uncertain historical publication
outcomes remain explicitly accounted for below; this is not an error-free fleet claim.

The first requested release was `6a9d67fc`; its exact Required and CodeQL checks
passed before image preload. The prior runtime was
`a8567220a2ec7466fa4a3c832ab75ee4fb201785`.

## Reviewed cleanup

The initial root filesystem sample at 05:55:26 had 21,052,084,224 available
bytes, below the unchanged 21,474,836,480-byte API deployment floor.
Manifest-aware image reclaim found no eligible release images. Six retained
manifests protected thirteen image identities/references and sufficient distinct
component history; these were preserved.

BuildKit reported approximately 5.027 GB of private reclaimable cache, including
other applications. Cleanup selected exact cache IDs attributable to MAXIM
Dockerfile instructions and their verified intermediate descendants. Each apply
rechecked descriptions, regular-cache type, private ownership and reclaimability,
held the standard deployment lock and passed the ordinary maintenance guard.
Docker applied the exact-ID filter without `--all`. The second pass included
five intervening MAXIM copy layers; it removed the age filter because removing a
child updates its newly unreferenced parent's last-use timestamp. Both passes
retained the reviewed ID selection and Docker's in-use/shared protections.

The first pass freed a net 751,415,296 bytes; the second freed 1,831,395,328
bytes. These are immediate filesystem before/after differences under continuing
production traffic, not estimates from displayed layer sizes. The combined net
gain was 2,582,810,624 bytes. No volumes, databases, queues, backups, recovery
evidence, release images, generic npm cache mount or sibling application caches
were removed. The standard disk guard passed after cleanup.

## Docker history-query failure and restoration

At approximately 05:57:00, an inspection using
`docker buildx history ls --format json` triggered a Docker daemon panic in
BuildKit v0.28.1's `filterHistoryEvents`, at `history.go:1074`, while sorting
history records. This was a read-only query, before cache deletion. A second
pending history-query shell was cancelled without executing that query.
Do not repeat that command on the affected daemon. Plain `docker buildx du`
inventory succeeded; its JSON was filtered outside Docker instead.

Systemd restarted Docker, but only three of the formerly running containers
returned automatically. Existing PostgreSQL/Redis, native services, static
services and application containers were started again under the deployment
lock, preserving their original images and volumes. The four containers already
stopped before this incident remained stopped. At 06:03:28 all 31 previously
running containers were running again, both MAXIM native services and sibling
health checks were healthy, and ingress/admin live plus public live and `/app/`
returned HTTP 200. This confirms service restoration, not absence of uncertain
in-flight effects or recovery of the pre-existing ordered backlog.

## Release evidence

The normal exact-SHA preload wrapper verified the CI artifact checksums, source
labels and protected-image labels for API, mini app and Safety Desk. The loaded
API image identity is
`sha256:67389eb2bd0bf013d951e22aa74073d6b6c10eaef217d9003a39a5b9fc7690a9`.
This is the actual loaded artifact identity; an intermediate CI build-log config
digest must not be substituted for it.

Normal deployment adopted the single validated interrupted release journal and
selected all three active components. Its reuse-only disk preflight admitted
23,369,383,936 available bytes with the unchanged 20 GiB floor. Release completion
requires the standard strict smokes and a newly recorded component manifest;
image preload and running containers alone do not establish completion.

The deploy passed the exact API-image fence and resumed webhook queues, but its
normal 900-second ingress readiness wait expired. No retry or timeout extension
was performed. At 06:32:43, all fourteen API roles, both native auxiliaries and
both active static services matched the target component images and were running,
with zero container restart counters and no OOM. Live and static smokes returned
200; both private readiness endpoints returned 503. `current.json` remained
absent, and the interrupted transition evidence was retained. Available root
space was 23,355,129,856 bytes. This is a deployed runtime, not a finalized release.

## Queue verification and recovery refusals

The post-transition census beginning at 06:22:04.541 covered all 53 active queues
and the retired VK sentinel. Across its non-atomic samples there were zero waiting,
1,189 prioritized and sixteen active jobs, with 7,508 future delayed jobs and zero
due delayed jobs. Counts alone do not prove latency or successful external effects.
The bounded SQL RECEIVED sample decreased from at least 2,000 after Docker
restoration to 377 after deployment; QUEUED decreased from seventeen to one fresh
two-second-old event. The oldest ordering predecessor remained a historical
`canonical_business_started` timeout quarantine, approximately 6.4 hours old.

The 06:23:33–06:28:33 five-queue error sample found 42 administrator-roster failures
matching the explicit-activation guard and five interactive MAX HTTP 404 failures.
It found no fresh Publisher binding-refresh/comment or background-action failures
in that window. Earlier post-transition samples did contain three unclassified
Publisher comment errors; a later zero count does not resolve those outcomes.
The 06:28:42–06:38:42 moderation/enqueue log sample also retained one background
execution-settlement failure, two preparation failures, two slow completions and
eight subscription fail-open observations. These samples are not fleet acceptance.

Two fresh online ordered inventories retained their successful pages but refused
with `inventory_statement_timeout_page`; neither established full coverage. The
second began after the observed RECEIVED population had fallen to 377. Their
requests, cutoffs and checkpoints remain private and unchanged.

Read-only stock source-abandonment preflight for three of the seven previously
identified owners refused at 511 pages with `REDIS_STORE_OR_SOURCE_REFUSED` on
`redis:max-actions-background`. A fresh single-owner preflight used 263 pages and
refused with both `ACTION_PAGE_UNPROVED` on `redis:max-actions-interactive` and
`CATALOG_DEADLINE_EXCEEDED` on the namespace catalog. The mixed refusal is not the
sole action-page condition eligible for the session planner's bounded retry.
The remaining prepared requests were not executed after this global proof refusal.
Neither preflight stopped the fleet, installed a hold, discarded a source or
authorized mutation. No collector budget, deadline or ordering fence was relaxed;
no successful release or latency-acceptance window was recorded.

## Authorized bulk cancellation and release recovery

The operator's subsequent instruction explicitly requested the existing stuck-event
cleanup mechanism and autonomous execution. The normal bulk cancellation protocol
was selected instead of weakening the refused source-profile collectors. Its fixed
request was `a2798a31-9e4e-4295-a522-995d01885fd9`, cutoff
`2026-10-11T06:50:00.000Z`, and the same exact `6a9d67fc` source/image above.
The prior completed cancellation journal was retained by the normal controller.
Before the operation, all eighteen target containers were running their exact images,
31 containers were running across the shared host, and 23,172,603,904 bytes were free.

The guarded connector verified Required and CodeQL, and the controller stopped the
captured API/native generations once. It projected 358 receipts to CANCELLED and
removed 365 selected BullMQ jobs, with zero retained locked jobs. The host journal
reached COMPLETE and restarted its captured generations. Original receipts/errors,
claims, uncertainty, existing holds, publications and future schedules were preserved.
This is cancellation, not successful historical processing or proof of absent effects.

Immediately after restart, readiness was still degraded and its queue sample was
stale. A bounded activity sample found oldest-metadata reads active for up to 61 seconds,
waiting on database I/O. The initial 120-second readiness observation refused; its
failed evidence was retained. At 07:13:05 both readiness endpoints returned 200 and
raw lag was 0.348 seconds. The normal recovery finalizer then passed strict API,
static and native checks and recorded
`release-finalized-20261011T071757Z-6a9d67fcae74-2232340` without recreating runtime.

A subsequent optimization selects a single covered `(status, created_at, id)` index
head for each literal pending status before fetching metadata by primary key. Native
regressions cover empty queues, timestamp ties and 60,000 terminal receipts. The
new fixed `postgres-audit webhook-cohort` report reads all seven statuses in a closed
30-second receipt-created window, capped at 512 rows plus a sentinel per status,
and separates pending age, invalid clocks and processed-only latency. Neither change
alters receipt status, execution authority or readiness thresholds.

The 07:18:55–07:19:44 queue census covered 53 active queues and the retired VK sentinel:
1 waiting, 1,077 prioritized, 8 active, 7,525 delayed and no due delayed jobs. The
Publisher runtime heartbeat was fresh with matching enabled configuration and bot
identity, without an operator pause. The older monitor's thirty-minute SQL signal
report timed out under its unchanged limit; that sample is incomplete.
The 07:17:56–07:22:56 error sample classified 23 roster failures as explicit activation
requirements, 12 combined binding/interactive MAX 404 failures, and six send-side auto-delete
exact-presence outcomes retained as access-ambiguous. It recorded no fresh comment failure in that particular window.

The moderation outcome sample at 07:22:24 included 44 independently verified mute
enforcement deletions, one confirmed administrator ban and twenty newly installed
mutes. Its 512-event cap was reached, covering events back to 07:20:01; it does not
prove all attempted effects or the whole hour. Publisher publication audit also
retained historical AMBIGUOUS/FAILED occurrences and sent-delivery receipts; these
were not replayed or reclassified to make counts disappear.

## Fresh local-limiter stall and correction

The post-finalization readiness observation failed at 07:24:57 when raw lag reached
10.029 seconds. By 07:35:31 readiness was 503 and raw lag 154.749 seconds. An indexed
owner-proof audit found a new predecessor created at 07:32:55.262, with business
started at 07:32:57.493, no finished-handler checkpoint and a retained enforced
READY claim. This was fresh post-cancellation work, not historical cleanup residue.

The 07:32:59.066 failure in `api-moderation-realtime-d` was at
`required-subscription.delete-authority`. The exact running image's MAX client
location throws `MaxApiInternalRateLimitError` before transport. The prior correction
recognized HTTP 429 with explicit GET provenance but missed this concrete local
limiter error, which has no Axios response or method. The post-notice handler
therefore retained its started fence and blocked its dependent ordering scope.
Zero DELETE ledger observations did not establish absent effects or authorize replay.

The correction admits this concrete local error only at exact author/source GET
boundaries, retaining no-response/method checks and all attempted/ambiguous mutation
fences. Initial no-effect qualification, durable guarded SEND and committed DELETE
handoffs keep their existing authority and original deadlines. Final workers must
still obtain fresh source/member evidence. Native regressions exercise both read
boundaries, real queue persistence, final refusal, policy/membership/deadline changes,
following same-chat progress and no replay of notices or the started handler.

A bounded background-queue error census over 06:46:12–07:46:12 identified a
PostgreSQL deadlock, rather than a MAX mutation error. Its compiled failure
location was the receipt update during SQL completion after the separate durable
finished-handler checkpoint. Existing checkpoint recovery retains the exact CAS
and does not repeat the handler. This observation does not prove every completion
error has the same cause; no lease/CAS or uncertain-effect fence was relaxed.

## Validated forward release and fixed recovery scope

The forward correction is `b29d7f78990bb8f8f104849679eb5fc531a1f6c8`, including
`f9e7515db2d28328a9def605af8f2ccbba244a6e`'s pending-metric query and closed-cohort
catalog. Local validation passed 325 focused unit tests, 93 native full-path tests
with PostgreSQL 16/Redis 7 and no skips, and the staged wrapper's 19,059 API tests.
The standard API run skipped 2,112 store/environment-dependent cases; that run alone
is not real-store coverage. Repository static checks passed 2,647 tests with 23 skips.

Exact-SHA CI run `38123173147` and CodeQL `38123173113` succeeded. The first CI Static
attempt aborted a Node subprocess in the unchanged participant-report rollback guard
fixture. The focused local guard passed; the failed CI job was rerun on the same SHA
after the other jobs completed. Its static/infrastructure checks and Required then
passed. No assertion, production guard or CI requirement was removed or bypassed.

The guarded preload checked archive checksums, exact revision/protection labels and
capacity. The loaded API image is
`sha256:a3d5af2a1ea11da367c085a1133517ea772d248aaaab0827aef40bdf56912808`.
At 08:29:36, Docker had 22,512,369,664 available bytes, above the unchanged 20 GiB floor.

A final owner-proof sample at 08:25:46 still identified the original 07:32:55 started
owner without a finished checkpoint. With the tested correction already preloaded,
the authorized cancellation used a matching clean `6a9d67fc` controller checkout and
fixed operation `7151feb3-9aaf-4826-9c67-3e66a0db2a60`, cutoff
`2026-10-11T08:28:36.809Z`. It ran immediately before the forward deployment; the cutoff
was not repeatedly advanced. The first capture saved nine receipts, then stopped on
SQL statement timeout `57014`. A fixed activity audit found no remaining active query.
The identical request resumed with unchanged budgets and completed: twelve receipts
were CANCELLED, 113 related jobs removed, and zero locked jobs retained. Claims,
original evidence, publications, future schedules and prior holds were preserved.

Normal API-only deployment reused the exact image, passed the unchanged disk guard,
and found no pending migrations. All fourteen API roles and both native auxiliaries
were recreated. The two static components retained their previously finalized images.
During restart the normal ingress backlog exceeded the queue report's 2,000-row cap.
Its oldest inspected receipt had no execution claim or earlier ordering predecessor;
this was preparation backlog, not evidence for replay or another cancellation. The
sample later fell to 1,036 receipts with an advancing oldest head. Existing processing
drained it without another cleanup, capacity override or longer readiness timeout.

The ordinary strict API/public/native smokes passed and deployment committed
`release-20261011T083353Z-b29d7f78990b`. At 08:47:16, all sixteen API/native containers
had the exact new image, zero restarts and no OOM. Available Docker space was
22,484,680,704 bytes. Publisher dispatch reported enabled matching runtime configuration,
no pause, fresh enabled heartbeat and ready secrets. The temporary old-source controller
worktree was archived successfully after its completed operation.

## Publisher observations during verification

The bounded 07:58:59–08:08:59 log sample was not truncated. It recorded 1,073 scheduled
bot-access probes, of which 1,071 confirmed before their deadline, one was a transient
error and one remained unresolved in that sample. All ninety urgent webhook-observed
refresh attempts and 519 binding-maintenance attempts returned without throwing.
Seven stale-user-access attempts threw and retained their normal guarded retries;
the successful bot probes are not proof of those users' authority or send completion.

The reviewed indexed access census at 08:09:16 included all 23,169 binding rows under
its 50,000-row cap, with one active bot scope. Of 1,233 confirmed-admin bindings,
1,223 had fresh evidence and ten were expired. Snapshot freshness does not prove
historical deadline success or authorize renewal without fresh rights. The Publisher
priority queue decreased from 966 tasks in the earlier 07:19 census to 487 around
08:20, confirming movement rather than a stopped queue. The same queue census retained
future schedules and historical failures; neither was relabeled as executable backlog.

After deployment, the untruncated 08:48:09–08:58:09 execution-log sample contained no
new handler/completion/preparation failure diagnostics across enqueue and all seven
moderation services. The moderation-outcome audit at 08:58:10 reached its 512-event
cap, so it covers only 08:51:52–08:58:09 of the requested hour. Within that sample it
reported 49 independently confirmed mute-enforcement deletes, two confirmed admin
bans and nine mute installations. These are observed outcomes, not proof that every
attempt succeeded or a count of all events during the hour.

The untruncated Publisher delivery log sample at 08:50:02–09:00:02 recorded 273
`receipt_persisted` observations: 260 NOW and thirteen RECURRENCE. These are durable
receipt observations, not deduplicated publication totals or exactly-once telemetry.
The largest measured intent/schedule-to-receipt delay was 187,198 ms. Its separate
08:48:09–08:58:09 access sample recorded 1,041 scheduled bot probes, with 1,037 confirmed
in time and four unresolved observations, plus nine publication-due probes confirmed
in time. Of 98 urgent webhook-observed refreshes, 96 returned and two threw; 529
binding-maintenance and 92 publication-actor-due refreshes returned without throwing.
These guards remain active: unavailable access does not become permission to publish.

The final fixed census covered 54 queue names, including the retired VK sentinel:
7 waiting, 1,253 prioritized, fourteen active and 7,501 delayed tasks, with one due
at the instant sampled. Publisher binding refresh had 954 prioritized and two active
tasks, with no failures in that queue's five-minute window. These are non-atomic
workload snapshots; advancing refresh work, future schedules and retained failed
history were not purged or presented as zero backlog. The separate webhook receipt
cohorts and readiness interval measure completion latency.

Historical Publication AMBIGUOUS/FAILED evidence and in-progress delivery recovery
remain under their existing fences. The action logs also retained 31 source-presence
404 observations and their matching poll-render refusals over ten minutes. Existing
bounded five-minute poll repair backoff remains in force; MAX GET 404 alone cannot
prove absence or authorize resend. No user message, uncertain send receipt, execution
claim or publication was deleted to remove these diagnostics, and no live diagnostic
message was sent to user groups/channels.

## Sustained latency observation and final limits

The readiness observation retained its two initial 503 samples at 08:47:35 and
08:47:40, with raw lag of approximately 114 and 119 seconds. These are outside the
accepted interval. From 08:47:45.403 through 09:02:45.684, all 180 samples had both
private readiness endpoints returning 200 with raw queue checks passing. The
900,281 ms interval had maximum raw lag 6.969 seconds, below the unchanged ten-second
threshold, fresh queue measurements and no gap exceeding the collector's limit.
This establishes sustained queue readiness, not successful completion of every action.

Six separate closed thirty-second receipt-created cohorts were nonempty and complete,
with no status truncation or invalid clocks. They are sampled windows, not a census
of all arrivals during the fifteen minutes. The first precedes the accepted readiness
interval; the other five fall inside it.

| Receipt-created window | PROCESSED | DUPLICATE | FAILED | Processed-only p95 |
| ---------------------- | --------: | --------: | -----: | -----------------: |
| 08:46:35–08:47:05      |       313 |        94 |      0 |           1,104 ms |
| 08:49:36–08:50:06      |       394 |       114 |      0 |        1,535.75 ms |
| 08:52:36–08:53:06      |       505 |       202 |      0 |           2,626 ms |
| 08:55:36–08:56:06      |       394 |       114 |      0 |        2,073.95 ms |
| 08:58:36–08:59:06      |       394 |       106 |      0 |        1,720.35 ms |
| 09:01:36–09:02:06      |       367 |       102 |      1 |         1,540.4 ms |

The combined samples contain 2,367 PROCESSED, 732 DUPLICATE and one FAILED receipt.
Every sample had zero RECEIVED, QUEUED, CANCELLED and NO_REPLAY_HELD receipts.
The p95 values exclude unsuccessful receipts and do not measure remote effect latency.

The 08:53:57–09:03:57 bounded execution-log sample contained no matching
handler/completion/preparation failure diagnostics and was not capped. A separate
bounded Redis census around 09:05 found one `database_query_error` observation in
`moderation-join-0`; it did not retain raw errors or identities. At 09:06:59 the
fifteen-minute failed-job census had no observations or truncation, and fixed retry
audits at 09:03:57 and 09:11:47 returned `no_scheduled_retry`. These aggregate probes
cannot establish identity between the SQL FAILED receipt and the Redis error or
prove that receipt's final SQL outcome. The worker can throw during preparation
before the handler's diagnostic boundary, so absence of that diagnostic is not
proof of success. No speculative replay or extra cancellation was performed.

At 09:11:14 both readiness endpoints still passed, with raw lag 1.395/1.426 seconds.
All fourteen API roles and both native auxiliaries were running the exact final image.
The fourteen API roles and photo auxiliary had zero restarts and no OOM. The queue
audit showed 22 RECEIVED receipts with oldest age two seconds and ten QUEUED with
oldest age four seconds; neither selected head had an ordering fence. The historical
FAILED status hit its 2,000-row cap and was not treated as fresh executable backlog.
Available Docker filesystem space was 22,220,890,112 bytes, still above the API floor.

The OCR auxiliary had six restarts after the earlier zero-restart attestation.
An uncapped lifecycle-log sample from 08:47:16 through 09:12:31 accounted for all six
as `native_timeout` during `recognize`, with no unclassified lifecycle events. It was
running and healthy with no OOM at the final probe. These are mandatory isolated
container recycles after incomplete native analysis, not six successful OCR analyses.
The existing terminal-incomplete behavior, original deadlines and full containment
remain intact; no timeout was widened or uncertain native operation retried to improve
the apparent success rate. Queue readiness and a healthy restored sandbox do not
establish OCR coverage for those six attempts.
