# Legacy webhook recovery with permanent holds

Use `vps-connect.sh legacy-cold-recovery <private-request.json>` for the reviewed,
finite abandonment protocol. The former deploy flags `--legacy-order-preview`
and `--legacy-order-apply` and the retired direct controller remain disabled.
Do not invoke native test fixtures or the store writer directly in production.
A diagnostic candidate is not evidence that its historical effects never occurred.
A newly allocated unstarted claim can still belong to an original pre-migration
receipt; source and owner birth define that historical scope, not claim birth.

The operation preserves the original event, claims, settings and unknown action
receipts. `NO_REPLAY_ORDER_RELEASED` and positive `NO_REPLAY_HELD` receipt pointers
mean explicit abandonment under permanent protections; they do not mean execution
succeeded. Participant, global-user and exact-source holds never expire. They
suppress automatic sanctions and deletion for the protected participant. New
post-seal administrator commands use a separate command-only path with persisted
source proof and fresh actor/bot authorization before execution and final notice
send. Unknown historical commands remain blocked. A held author's `Старт` source
message is not automatically deleted.

## Install compatible tooling

All 14 API roles and both native auxiliaries must first run the same reviewed
source and immutable image. The host checkout must be clean at that exact SHA.
This compatibility deployment alone does not remove an old ordering barrier.
Use the normal exact-SHA CI gate, or an explicitly authorized emergency reason;
a successful live endpoint alone is not completed recovery. During a queue incident,
`MAXIM_DEPLOY_API_READY_TIMEOUT_SEC=180` bounds the compatibility rollout wait;
the connector accepts caller values from 180 through 3600 seconds without
weakening readiness or recording a successful release.

All supported runtime entrypoints serialize through the persistent, protected
`/var/lib/maxim-deploy/deploy.lock` inode. Never unlink it. Before the first
PID-lock to flock transition, establish an exclusive operator maintenance window
with no incompatible legacy launcher, backup or repair process. Then run:

```sh
./infra/scripts/vps-connect.sh install-deploy-flock "$MAXIM_REVIEWED_OLD_HOST_SHA"
```

The local exact HEAD is the target. The helper refuses an existing legacy lock,
checks for incompatible processes, holds both protocols while fast-forwarding the
clean checkout, removes only its own PID lock, and proves the inherited flock.
It does not build, start/stop containers or touch SQL/Redis. A failure after source
synchronization requires inspection of the actual HEAD before another attempt.
Never use an old deployment wrapper to synchronize into new lock tooling.

## Bounded admission and cold review

Requests are regular, single-link, owner-only `0600` JSON files, at most 64 KiB.
The online request is:

```json
{
  "version": 1,
  "operation": "preflight",
  "targetSha": "<full-reviewed-commit>",
  "selection": {
    "ownerWebhookEventIds": ["<reviewed-owner-id>"],
    "majorBotIds": ["<all-reviewed-Major-bot-ids>"]
  }
}
```

The host independently derives the Major catalog from the exact admin container;
Publisher is excluded. Selection is finite (at most 200 owners/100 bots). Supported sources are original human plain text in a Major group and a strictly
validated flat forward with text or at most ten complete image/photo attachments.
Direct sources also admit at most ten strict image/video attachments and bounded
passive formatting spans from the official MAX shape. Video URL/token and scalar
metadata must validate; formatting cannot introduce links, mentions or targets.
Commands in direct, forwarded or composed text, replies, unknown fields and
ambiguous provenance refuse. MAX `seq` is opaque int64 metadata; explicit `mid`
supplies identity even when the sequence exceeds JavaScript exact integers. The modern duplicate guard checks both source
authors; retired photo evidence cannot authorize new deletion. Held media jobs
settle without download or repeated deferral.
The collector uses bounded exact source/claim/mirror reads and reviewed reachable
effect-family guards. It also checks the pending prefix of each selected chat
against the actual receipt materializer in a read-only snapshot: old commands,
started effects, unsupported sources and exhausted budgets refuse before stop.
Cold inventory repeats this prefix check and binds its stable semantic digest.
Preview groups receipt and claim reads in pages of at most 200 exact keys, using
indexed lateral probes; every key, response byte and query shares the existing
total budget. It never scans retained claim history for a batch.
It must report complete source coverage and
`READY_FOR_COLD_REVIEW` before any producer is stopped. A DENY leaves the runtime
running and writes private diagnostic evidence. Do not raise budgets to force an
incomplete inventory through admission. The inventory fence nonce is the SHA256
of the host controller nonce, matching the queue owner token encoding.

For a source refusal, `postgres-audit legacy-order-candidates` schema v2 keeps
the same two indexed first-row probes and adds bounded structure diagnostics for
that one candidate. `source_shape` contains only booleans and JSON type names;
it never includes message text, identities or unknown field names. The 256 KiB
shape ceiling is explicit. These observations neither validate the complete
source nor permit replay, stopping or installation. No extra audit grants apply.
For several independent blockers, `postgres-audit legacy-order-window --explain`
plans a fixed 128-receipt window plus one saturation sentinel and at most 32 chat
predecessors. Review the plain plan, then omit `--explain` for candidate IDs. Chat
grouping occurs only after the bounded status-index read; each chat still exposes
its first actual predecessor, including ineligible fences. Truncation and unknown
sources remain explicit. This window is not a fleet census or recovery authority;
every finite selected owner must still pass online admission and cold inventory.

Change `operation` to `prepare` only for an approved selection. Preparation runs
native smokes, repeats fresh online admission, requires a 10 GiB Docker reserve,
and refuses an existing queue fence. Its OCR readiness probe accepts a fresh, purely
queue-backlog failure only when DB/Redis, the OCR worker and verified native identity
are healthy; final recovery and release readiness remain strict. This avoids requiring
an already drained queue before recovery can begin. It writes a durable journal before stopping
exactly the captured 14 API and two native generations. Each must use
`unless-stopped`. PostgreSQL, Redis and unrelated containers are preserved.
The controller pauses/rechecks all 24 webhook queues, collects the authoritative
cold inventory, and leaves producers stopped in `INVENTORIED` for review.

Host identity, monotonic epoch, source/image, exact generations, selection,
controller nonce and inventory/preview hashes are immutable. Private inventory
and proof artifacts are bounded to 8 MiB. SQL query-plan timings and cache costs
may differ on recheck; every semantic source/decision/child field must agree.
Diagnostics are retained separately and never authorize changed source evidence.

## Install, verify and resume

Apply uses the three exact hashes returned by successful preparation:

```json
{
  "version": 1,
  "operation": "apply",
  "targetSha": "<full-reviewed-commit>",
  "expectedJournalDigest": "<reviewed-current-journal-sha256>",
  "reviewedPreviewDigest": "<reviewed-preview-sha256>",
  "reviewedInventoryDigest": "<reviewed-inventory-sha256>"
}
```

Apply independently rechecks stopped identities, queue ownership and the same
inventory. A constrained disposable client installs the certificate and immutable
holds; it has only SQL/Redis credentials, no MAX tokens. The exact client must be
removed before independent positive SQL readback. Lost writer output never
permits replay. Finite indexed materialization then writes positive held receipt
pointers (200 rows/page, at most 200 pages/120 seconds), with another readback.
Only complete protection and chat cursors permit starting captured native
containers, then the 14 captured API containers. Wait for the captured native
healthchecks after Docker start; `starting` is not a changed generation. Native
checks precede queue resume. Three fresh samples must prove healthy DB/Redis,
exact runtime identities and released queues. A purely automatic queue-backlog
failure may remain visible while this positively proved scope completes with
`fleetReady: false`; it cannot stop unrelated chats. Other failures remain contained.
Fleet recovery and release finalization still require strict ready and lag at most
10 seconds; scope completion alone must never be reported as a drained fleet.

Any failure after cold admission attempts to stop the captured runtime first,
remove its exact client, pause its queues and persist the blocked state. It never
starts old images or automatically restores the baseline after a refusal.
Every ordinary deploy, rollback, reclaim and supported topology mutation refuses
while this journal is incomplete; missing/corrupt evidence also refuses.

A process interruption after installation can be reconciled with the same request
shape and `operation: "reconcile"`, using the current reviewed journal digest.
Only `INSTALLING`, `SEALED` or `RESUMING` are eligible. Reconciliation first stops
producers/removes the old client/pauses queues, then reads the existing certificate
independently. It **never creates or installs a certificate again**. An absent,
unsealed or mismatched certificate stays blocked. A positive existing seal may
finish bounded receipt materialization and repeat the same strict restart checks.
A pre-install read/stop interruption can use `operation: "retry-preview"` with
`version`, `targetSha` and the current `expectedJournalDigest`. It re-proves the
same stopped fleet and owned queues, then repeats read-only preview. It cannot
install anything, change an existing reviewed inventory, or restart producers;
`INSTALLING` and later phases refuse this operation. A corrupt/interrupted durable
filesystem write requires separate diagnosis. There is no generic reset,
abort-and-start or bypass command.

## Release acceptance

Cold recovery does not write a current release manifest. After the journal is
complete, use the official `finalize-release-recovery` wrapper to prove all
required component identities, strict smokes and queue-fence release. Record the
actual exact-SHA CI results; never hand-write a successful manifest. Manifest-aware
reclaim normally follows finalization. When disk capacity blocks another recovery,
it may use exactly one complete verified transition as the recovery base after the
previous cold journal is complete. Review its explicit `--dry-run` first (the reclaim
helper defaults to apply); keep the shared lock, ordinary-effect authority check,
all retained images and component history floors. Preserve volumes, rollback images
and sibling projects. See `storage-cost-rollout.md`.

Retain exact release/time windows and distinguish ingress, selection, ordered
waits, held dispositions and confirmed remote actions. No live test messages go
to user chats. Seven-day independent duplicate labels, two-day holdout and
sustained fairness/capacity acceptance remain separate from queue recovery.
