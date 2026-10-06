# Legacy webhook dispositions: compatibility only

Production cold recovery is **disabled** in this release. Both explicit deploy
arguments (`--legacy-order-preview` and `--legacy-order-apply`) refuse locally
and in the VPS deploy script before credentials, SSH, migrations or runtime
transitions. The direct controller and built store CLI also refuse with the
static code `cold_activation_disabled`. There is no environment or caller
bypass. The store CLI opens no database/Redis connection and consumes no request
body. Native recovery orchestration lives only in the excluded test fixture and
accepts isolated local race-test stores.

No production certificate or hold has been installed by this work. Do not invoke
the test fixture or low-level installation helpers against production. The
candidate report is read-only and grants no recovery, replay or startup authority.
A compatible release does not remove the existing unverified ordering barrier
and must not be presented as restored readiness or an unloaded queue.

## Compatibility foundation

The additive migration creates three empty safety tables. Mandatory runtime
readers and both rollback source floors preserve permanent source, participant,
global-user and exact-child holds if a future independently approved protocol
installs them. Runtime consumers cannot create, expire or remove holds.

A `NO_REPLAY_ORDER_RELEASED` record is an explicit abandonment of an unverified
historical Major group message. It is not `COMPLETED`, `EXECUTION_FINISHED`, proof
of absent old effects, or a new MAX effect. The low-level native fixtures require
installation and the v1 certificate seal in one transaction; a crash can leave
an empty unsealed certificate, never an installed unsealed batch.

Original receipt/claim/payload/settings evidence and unknown action journals
remain intact. Exact confirmed remote receipts may settle their existing SQL
journals without another MAX operation. Age, zero enqueue attempts, restored
permissions and missing ledger rows do not prove an old remote outcome.

The cost of a permanent participant hold is deliberate: automatic moderation in
the source chat and automatic global reputation/enforcement are suppressed. The
conservative shared receipt guard also suppresses that participant's later group
commands, including administrator commands. Authorized private settings remain
available. The explicit Major private CHAT-settings dialog shows the warning
after existing exact-chat admin authorization, without exposing identities or
sending group/channel diagnostics. This is not a fresh MAX cache-bypass claim.

## Activation blockers

The withdrawn controller warmed action/Publisher/retention roles before taking
the cold inventory. A webhook pause does not fence MAX queues or SQL-backed
pollers. It also restarted compatible roles after refusal or unknown SQL output.
Either interval could execute work before durable protection. A new protocol
must stop every effect producer before target startup and retain a typed durable
startup guard through preview, refusal, crashes and unknown results. Normal
deploy and both API rollback paths must honor that guard.

The current held-receipt reader only updates untouched receipts created after
the seal and can return true after zero updates. Pre-seal held `RECEIVED` and
`QUEUED` rows therefore retain their operational status. In production ingestion,
even post-seal held rows can be skipped before preparation because ordered-head
selection excludes the scope. Raw status-based lag still sees them. A successful
low-level seal alone cannot restore readiness. The candidate report can also
re-propose a preserved owner which already has a sealed disposition, hiding the
next unresolved blocker.

These limitations are unresolved and quarantined by the activation gates. Do
not fix them by declaring execution successful, broadly clearing status/error
markers, adding an unbounded hold anti-join to health, or extending timeouts.

## Required corrected protocol

A future activation change must independently implement and review:

1. One durable cold maintenance journal binding the validated interrupted-release
   baseline, exact target source/image, owned queue nonce, selected owners,
   preview digest and stopped container generations. The baseline identifies the
   pretransition release; it must not be confused with the target source SHA.
2. Stop all old effect producers, perform only fixed store migrations, and create
   compatible target API generations without starting their applications.
   Prove singleton identity and no running, restarting, paused, dead or foreign
   producer. Preview is maintenance output and leaves roles stopped; it cannot
   resume queues or commit a successful current manifest.
3. Apply re-proves the same immutable evidence and two bounded pending inventories.
   Only exact positive SQL proof of the atomic installed/sealed batch grants
   startup. Refusal, malformed output, lost response, signal or uncertain client
   removal grants no restart. SQL may already have committed; preserve its
   evidence and reconcile it through a bounded read before retry.
4. Positive versioned receipt dispositions separate held raw evidence from
   actionable backlog through bounded indexed materialization. Unsealed,
   missing or mismatched authority and the next genuinely unknown predecessor
   must remain blocking. Candidate discovery must progress past proved releases
   without skipping earlier unknown fences and report incomplete bounded walks.
5. Real production ingestion regression coverage: `storeReceipt` through actual
   outbox selection/sequence for held-only chats, a later independent message,
   nine mirrors and edits. Test long held prefixes and mixed unknown fences with
   representative native PostgreSQL plans. A direct preparation call is
   insufficient evidence of lag progress.
6. All pre-seal and crash/fault cuts: retained generic SEND with absent/ENQUEUED
   journals, DELETE/member children, SQL pollers, local strikes/reputation,
   partial stops, drift, unknown commit and repeated same-SHA recovery. No MAX
   request or new local sanction may occur before positive startup authority.
   Mutation tests must enforce the active journal guard in ordinary deploy and
   both API rollback entry points.

The conservative first candidate class remains complete original human plain
text in a Major `CHAT`. Publisher/private/channel sources, media,
replies/forwards/secondary subjects, bot/service authors, commands, scalar fields
hiding objects, mismatched bot provenance, and modern start/lease fields refuse.

The experimental proof budgets remain 200 exact owners, 256 queues, 1,000 Redis
SCAN calls, 5,000 pending children and 60 seconds preparation. Owner raw plus
normalized payload is at most 256 KiB per owner (up to 50 MiB serialized total),
with metadata and parsed-object overhead separate. Child data is at most 64 KiB
per job and 8 MiB per inventory. Redis 7 `EVAL_RO` rejects more than 200 returned
keys or 64 KiB key bytes; these bound transferred data, not server SCAN work.
Every pending non-MAX queue, unattributed SEND and related cross-chat SEND
currently refuses proof. None of these finite budgets certifies throughput.

## Stable release acceptance

Use the normal exact-green-SHA release wrappers without cold arguments, preserving
the session's caller-supplied 20 GiB reserve. A stable compatibility release still
requires all-role/native identity checks, strict live/ready smokes, recovered
queue outcomes and a recorded current manifest. If readiness remains blocked by
legacy evidence, report the interrupted release honestly and preserve the fence;
never fabricate a manifest or replay unknown work.

Sustained 10k/12k/30k throughput, native OCR/image capacity, designated live MAX
checks and four 24-hour rollout cohorts remain separate operational acceptance.
