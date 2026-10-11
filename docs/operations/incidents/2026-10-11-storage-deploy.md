# Storage cleanup and bot release, 2026-10-11

All timestamps below are UTC. The requested runtime release is
`6a9d67fcae74d037855d8bda98197c3e54f5818d`; its exact Required and CodeQL checks
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
