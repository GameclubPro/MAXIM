# Exact-source webhook abandonment

Use this only when an operator explicitly discards an unfinished modern webhook
source without replay. It does not establish that previous remote effects succeeded
or failed. A started execution claim and every existing action, sanction, DELETE and
ambiguous member receipt remain unchanged.

The source is an exact original message and its proved descendants. Human group
messages use `HUMAN_CHAT_V1`; channel messages with positively absent authors use
`CHANNEL_AUTHORLESS_V1` with a real null author. Never infer an author from a linked
message or substitute a synthetic user ID. Both profiles verify the original
payload against the real webhook parser and reject default or configured commands.

The human profile supports plain text, up to ten strict direct image/photo/video
attachments, one direct audio attachment, or one official SHARE preview. Flat
forwards and replies may contain linked text, up to ten images, or one video;
a forward may contain one SHARE preview and a reply may contain one sticker.
An absent linked sender is allowed only for a forward; supplied sender metadata
remains validated. Initial human message edits retain the same exact identity and
clock checks. A reply requires nonempty outer text and no direct attachments.
Nested links, linked audio, mixed preview/media and unknown metadata are refused.

Bounded formatting, credential-free HTTPS links and numeric user mentions are
passive metadata with offsets in the original UTF-16 text. Identical linked
formatting copied onto an empty outer forward is accepted only after separately
validating its linked text. Media is inspected without downloading, decoding or
transcribing it. The channel profile uses the same bounded direct media checks;
its finite passive keyboard profile supports validated HTTPS links and app-open
buttons without invoking them. Channel-only passive metadata also permits a strict
original HTTPS message URL and bounded scheme-less relative markup links without
whitespace, controls, colons, backslashes or a protocol-relative prefix. The original
parser comparison and stored payload remain unchanged; linked validation may omit
only the separately validated message URL. Existing legacy recovery retains its
own profile.

Only the original recipient chat, message ID and validated human sender, or explicit
channel author absence, identify the source. Linked identities never become held
messages or people. A distinct message remains outside the hold. Channel auto-post
markers are real effect evidence: inventory them by exact chat/message, retain
ambiguous receipts, and enforce source holds before marker claims and at final MAX
calls. SQL guards prevent inserting, updating or deleting a held source marker.
Publisher remains a separate observer/publisher, never a moderation executor.
Its exact configured `publisher-observation:v1` receipt key stays unchanged during
recovery. Inventory proves both the ordinary source claim and the absence of any
independent Publisher, linked-event, command or unknown-kind claim. Late receipt
materialization takes Publisher identity only from the sealed certificate's
original separate bot catalog; a missing catalog never authorizes that namespace.
Receipts of both profiles accept ingress's empty-object raw sampling sentinel only
while the original `normalizedPayload.raw` still passes every source/parser check.
Nonempty retained raw copies must match it; null, arrays and mismatched data refuse.
Initial channel owners still require a retained original under the SQL seal guard.
Source closure version 6 binds these receipt rules, and rollback must retain both
readers. Existing owner claims, receipt keys and raw evidence are never rewritten.
Legacy member/global-user holds are independent. Unsupported sources, independent
unfinished edited claims and unattributed actionable continuations are refused.

The automatic `PRISTINE_OPERATOR_DISCARD_V1` path accepts the strict human source
profile only for an expired, enforced, prepared owner that has never started and
has no lease, completion or command result. It requires the complete bounded
receipt family, a prior dormant observation, later scrubbed operator-discard
witnesses, exact claim ownership, current command checks and no existing hold.
The business-start fence prevents moderation and media handlers from running
before the retained claim starts. Settlement preserves the source and claim; it
does not cancel independent ingress retention or invent an execution result.
Started or uncertain owners still require the cold protocol below.

An interrupted queue pre-drain leaves the protected host sentinel
`/var/lib/maxim-deploy/queue-predrain-pending.json`. Ordinary deploy, rollback,
rollout and cleanup authority refuses while any entry exists at that path, even
when the preceding cold journal is complete. Queue-pause adoption does not bypass
this guard. Stock cold entrypoints also refuse while it exists; their read-only
`status` remains available under the deploy lock. Only the bound pre-drain recovery
controller may remove its matching
sentinel after proving the original auxiliary queue pause states restored; never
delete it manually to unblock a deploy.

`sendAutoDelete` consumes its parent SEND authority, so its exact original-source
envelope and parent key remain part of the exclusion. A nullable source message
requires the exact retained successful, terminal, unambiguous moderation-notice
SEND ledger row through the metered job-key resolver. Chat, bot, remote message,
timestamps, delay and the complete copied supported context must agree. Missing
parents, reply-link options, truncated option names or unknown contexts refuse
admission. A compatibility notice marker cannot exclude a selected source in the
same unresolved chat; a strict duplicate-notice context must prove its exact source.
`BOT_MESSAGE_AUTO_DELETE`
from a separately authenticated bot-message webhook has its own message-scoped
claim, current chat policy and origin-only bot routing. It does not consume the
abandoned human execution claim; this operation does not suppress that independent
policy.

## Preparation

Use a clean checkout at the exact reviewed runtime SHA with every API role and both
native auxiliaries running that image. Deploy the additive schema and mandatory
readers before any installation. Both rollback paths require the modern owner and
late-receipt profiles, including strict direct-media/forward/reply/preview provenance,
audio and link markup. Authorless channel holds additionally require the explicit
`CHANNEL_AUTHORLESS_V1` profile with a null author, channel receipt materialization
and source checks before polling or legacy-recovery marker claims. Existing human
v1 certificates retain their original meaning. The controller requires a 20 GiB Docker filesystem reserve and uses
the existing protected deploy lock and durable cold-operation journal.

Create an owner-private `0600` JSON request. A `preflight` or `prepare` request has
`version: 1`, the operation name, full `targetSha`, and this selection:

- `protocol: "source-abandonment-v1"`;
- one through eight exact `ownerWebhookEventIds`;
- the attested non-Publisher `majorBotIds` catalog;
- `abandonBefore`, a fixed elapsed UTC ISO timestamp with milliseconds.

The runtime, database clock, original source, migration boundary, exact claim,
bounded index plans, descendant inventory and current bot catalog must all agree.
Never derive settlement authority from age, a missing ledger row, arbitrary GET404
or a queue count. Preserve the exact window and release identity in the incident.

Redis structural admission performs two independent complete `SCAN MATCH bull:*`
censuses, each ending at cursor zero. Each pass caps database size at 12 million
keys, uses advisory `COUNT 4096`, and caps pages at 4,096 and duration at 20 seconds
inside the collector-specific shared 45-second deadline. The read-only collector
transaction has a 50-second timeout; legacy collection and SQL-only store budgets
remain unchanged. Structural census has separate
4 MiB namespace-reply and 16 MiB returned measurement-metadata budgets. Each
read performs one SCAN page, with every cursor accounted for. Atomic read-only
transactions run three EVAL_RO commands: commandstats projection, page, projection.
Each projection validates at most 64 KiB and 512 lines of internal INFO and returns
at most 512 bytes of original counter text. Exactly two completed EVAL_RO calls
must separate the snapshots; their reported time includes the first meter and
the whole read. Above 50 ms refuses admission after execution, without retry or
preemption. The final meter is outside that delta; the 20-second wall deadline
remains independent. This reduces returned metadata, not internal INFO work.
Redis 7.2+ Lua TIME is frozen. Structural census has separate byte/key/work limits
from the unchanged effect inventory limits of 512 pages,
50,000 probes and 8 MiB. It never substitutes a `:meta`-only scan, omits an unknown
namespace or deletes queue history to make admission pass. An unknown retired
namespace requires its own reviewed retirement procedure before a fresh admission.

Online admission uses a read-only PostgreSQL `ReadCommitted` transaction so a newly
observed Redis cleanup job can resolve its parent SEND committed after the initial
SQL inventory. A required-subscription cleanup job must retain its exact successful parent SEND,
equal canonical notice context and same-chat source proof. It is admissible only
when disjoint from every selected chat, including numeric aliases; mixed or
unproved contexts still refuse admission.
Other supported completed moderation notice cleanups use the exact versioned
`moderationSource` or `moderationRuleNotice` producer proofs. A durable
`moderationRuleFollowup` must accompany its rule proof with a matching historical
issue time and exact explanation/sanction SEND key; it cannot prove a source alone.
Combined rule/source proofs must name the same original message and user. Every
new combination remains disjoint from all selected chats, including numeric aliases;
unknown or mixed feature contexts remain refused. These checks prove retained
cleanup lineage only and do not renew an expired source deadline or permit replay.

Admission never authorizes stopping services or installing holds.
The frozen inventory independently repeats the full check under `RepeatableRead`
after producers stop; source selection, cutoff and equality checks remain unchanged.

Run the reviewed request through:

```bash
./infra/scripts/vps-connect.sh source-abandonment /absolute/private/request.json
```

`preflight` is read-only and leaves producers running. Review its complete evidence
before `prepare`. Preparation binds the exact generations, stops all fourteen API
roles and both auxiliaries, fences all twenty-four webhook queues, and captures a
bounded stable inventory. It does not install dispositions. A refused cold preview
leaves the operation fenced; inspect the journal and use its exact recovery path.

## Several certificates in one maintenance session

`infra/scripts/source-abandonment-session-cli.mjs` coordinates a complete finite
plan under the inherited deploy lock. Its bounded stdin request has an explicit
`preview`, `run`, `status`, `continue`, `reconcile`, `finish`, `partial`, or `abort`
operation. Use a clean reviewed controller commit with green exact-SHA CI. The
controller source and the running API image have distinct identities; child SQL
collectors and writers always execute in the captured immutable runtime image.

Before preview, complete the read-only ordered-anchor inventory. It walks
`webhook_events_ordered_chat_head_idx` through every non-null chat key before one
fixed cutoff, including later blockers in the same chat. A checkpoint binds the
request, exact running generations, immutable pages and actual end of range.
Historical failures outside the runtime ordering predicate do not belong to this
scope. An online end-of-range result nominates candidates only; it never proves
source eligibility, absence of remote effects or fleet recovery.

Preview authenticates that complete journal, attests the current bot catalog and
captures actual stock admission proofs for every selected child. Freeze the
queue-client bundle and its hash in private storage. A separate private feasibility
artifact binds the inventory digest, measured phase evidence, startup/readback
reserve, child count and aggregate work allowance. The checked-in limits are hard
ceilings, not a promise that every plan fits. Refuse an incomplete or infeasible
plan before pausing anything; never truncate the candidate set to fit a ceiling.
The CLI returns a private plan path and SHA-256 for a subsequent `run` request.
The parent ceiling is 32 certificates of at most eight owners each, 480 admission
calls, 2,048 proof files and 60 minutes. These independent ceilings do not establish
feasibility for every combination; each plan retains its actual phase estimates,
128 MiB evidence limit and reserved restoration time. The online admission deadline
is separate from the maintenance clock and remains explicitly bounded.

One durable session preserves all 53 original queue pause states, drains work and
stops the exact fourteen API and two native generations once. A full frozen
inventory repeats the ordered scope before any child installation. Every child
keeps its own certificate, selection, actual admission and stopped inventory;
source, claim, semantic and chat/message authority cannot overlap between children.
The existing per-certificate owner, SQL and Redis limits remain independent of
the full-inventory and session totals. `MATERIALIZED` is a child state and never
authorizes an intermediate restart.
The stopped inventory uses its distinct 1,000-row page format. Only a typed bounded
output refusal permits one 200-row retry at the identical cursor. Both attempts,
their plans and their actual transport costs are retained and charged; failed
larger reads do not become free work. The online inventory remains capped at 200.

The controller copies its reviewed finite store harness into private storage and
binds its hash in the immutable host context. One writer process executes a child's
certificate creation and installation as separate unchanged stock transactions;
a second process materializes at most 200 pages within the existing 120-second
window. Each writer is removed and absence is proved before independent read-only
seals. Lost acknowledgements never permit another installation attempt. The final
aggregate uses two separate read-only processes, each running one stock transaction
per certificate, and retains their raw results and child-bound proof references.
The reviewed runtime-restoration reserve remains unavailable to those readbacks.
Batching removes process startup overhead; it does not share or skip the four
complete Redis namespace scans performed for each child's two inventories.

The global journal lives in `/var/lib/maxim-deploy/source-abandonment-session`.
Its marker, immutable evidence and CAS transitions survive a lost response. An
`ATTEMPTED` child requires `reconcile` of that same certificate before any new
child; never replay an uncertain installation. Continuations require the exact
plan hash and current journal digest. Before the single native-first restart,
independently refresh every attempted child's positive seal and materialization
proof, remove store clients, and prove the same stopped fleet and queue fence.
Restore the original auxiliary pauses as well as the owned webhook fence.

`partial` requires every attempted child positively materialized and leaves all
unattempted and excluded sources explicit. `abort` cannot cross an unresolved
attempt. These are truthful terminal states, not complete backlog recovery.
If the runtime and final readbacks are already proved but the terminal journal
acknowledgement is lost, inspect the journal independently; do not blindly stop
the proved fleet or repeat writes. Ordinary deploy and rollback remain blocked by
every active, missing or malformed session journal.

Successful session completion is separate from release acceptance. Observe fresh
receipt cohorts including still-pending receipts, real outcomes, strict readiness
and queue trends after restart. Neither a finite set of installed holds nor an
HTTP success alone proves that all bots have recovered. Never-started backlog
requires its own reviewed cancellation authority or measured normal draining;
the session does not silently discard it.

## Installation and recovery

A started owner may retain a strict `EXECUTION_WAITING` checkpoint only when its
five fields match the current authority version, exact owner and semantic key, and
canonical immutable execution deadline. Business start must precede that deadline.
The original checkpoint remains unchanged: it records earlier readiness waiting,
not proof that remote effects were absent. Other non-null checkpoints are refused.

An `apply` request contains only `version`, `operation`, `targetSha`,
`expectedJournalDigest`, `reviewedPreviewDigest` and `reviewedInventoryDigest`.
Copy the digests from the independently reviewed frozen preparation evidence.
Selection and cutoff cannot change during apply or reconciliation.

The store creates separate `webhook_source_*` safety records. Unsealed source and
child holds already deny new effects, but only a complete immutable seal followed
by independently checked positive receipt proofs releases ordering. The original
owner stays FAILED; mirrors become NO_REPLAY_HELD. No successful engine checkpoint
is fabricated and no old claim is reset. Late observations of the exact held source
must independently qualify for their own positive proof.

After an unknown writer result, remove and prove absence of that exact disposable
store client, then read back the certificate. Use `reconcile` with the current
journal and reviewed digests; do not repeat an uncertain installation or remove
its journal. `retry-preview` is restricted to the same pre-installation context.
The modern controller cannot resume a legacy operation, or vice versa.

### Corrected controller for an admitted runtime

When a host-controller defect blocks an already admitted operation, use the
explicit corrective entrypoint only within its checked-in compatibility boundary.
It currently pins runtime commit `e7e0066ac724726b42c5cba00bfd8f930673b645` and API
image `sha256:c3e6540fa88d5695fb5c875a2baf7a7b7bf0b6c7c2a6907288f5217755727c45`.
The controller itself must be a distinct, clean, exact
descendant commit. The command checks CI for that controller commit; the normal
documented emergency exception requires both `MAXIM_DEPLOY_EMERGENCY_BYPASS=1`
and a nonblank `MAXIM_DEPLOY_EMERGENCY_REASON`. It never bypasses source, image,
journal, dependency, protocol, selection or queue-fence checks.

Synchronize the reviewed controller source without deploying an API image or
changing the stopped generations. Create a private `0600` envelope containing
only `version: 1`, the full `controllerSha`, and `runtimeRequest`. The nested
request is the unchanged reviewed `apply`, `reconcile` or `retry-preview` request,
or the explicit `refreeze-preview` operation described below;
its `targetSha` still identifies the original runtime. New preparation, admission
and status requests are unavailable through this path.

```bash
./infra/scripts/vps-connect.sh source-abandonment-corrective /absolute/private/envelope.json
```

The controller compares the complete source-tree delta against a narrow path
allowlist and proves disposition readers for both source commits. Compose,
protocol, store client, writer, runtime and smoke dependencies retain their
admitted versions. The journal adds only the typed pre-install refreeze transition.
Before any inventory or writer call, it saves a separate
immutable proof with both source identities, runtime image, current and expected
journal digests, request and selection digests, and the actual adapter hash.
The proof digest is emitted on stderr for private incident evidence. Original
journal bindings and the frozen reviewed inventory are unchanged.

Repeated catalog measurements may have different costs. Modern semantic comparison
excludes each catalog's direct `cost` field and only the numeric key counts of
`publisher-start` and `publisher-binding-refresh` between independently stable
inventories. These separate Publisher private-start and binding-refresh queues
cannot consume the selected non-command Major group source; their auxiliary TTLs
may expire while workers are stopped. Namespace presence, every other namespace
count, version, completion, issue, all queue headers and exact source/owner/action
evidence remain bound. Both complete raw namespace censuses within each cold
inventory must still match exactly, including both Publisher counts; the collector
and installer enforce the original census budgets independently. A disappearing
namespace, changed relevant orphan count, queue generation, membership, owner
payload or effect still refuses ordinary apply. This tolerance does not diagnose
the cause of an observed count change or authorize a refreeze. The fresh complete inventory is
saved as a separate recheck proof, and writers consume the original reviewed
artifact. A changed source, child, namespace or completeness result still refuses
installation.

If a complete fresh inventory differs only in independently reviewed Redis census
evidence before any installation, `refreeze-preview` creates one new review
boundary. It uses the same six fields as `apply`, carrying the current journal
digest and the original reviewed inventory/preview digests. It is available only
through the corrective entrypoint in `STOPPED` or `INVENTORIED`, with an existing
pending inventory, and only once per operation. It never ignores catalog drift
during normal apply and cannot cross `INSTALLING` or an uncertain write.

The fixed original store image must positively read the existing certificate as
`ABSENT` both before and after a fresh full collector run. Both reads mount the
original immutable inventory. All sixteen captured generations must remain stopped
and all twenty-four queues must retain their owned fence. The fresh inventory must
be ready with no issues and two complete matching namespace censuses; its binding,
selection, registry, SQL evidence, preview, selected claims, sources and children
must match the old review. No reason for changed counts is inferred from this test.

The new inventory is written as `inventory-<artifact-sha256>.json` alongside the
untouched original. A typed journal compare-and-swap saves a proof of the exact
previous journal and proof references, retains the two absence readbacks, and
replaces only the pending inventory and reviewed preview references. Later apply
uses the validated versioned filename; a new operation starts with its own
`inventory.json`. Review the returned new digests and full private evidence before
issuing a separate ordinary corrective `apply`. Any further census drift requires
new investigation; this operation is not a retry loop or an installation command.

Restart follows positive seal/materialization proof. Verify all fourteen API roles,
both native auxiliaries, released queues and fresh database/Redis health. A finite
operation may complete while other chats still have backlog; report that readiness
result honestly. Final deployment acceptance still requires strict release smokes,
fresh completed receipt cohorts and independent progress. Never hand-write a release
manifest or replay an abandoned source to make readiness green.

### Completed Start-confirmation cleanup

A nullable-source `managed_handshake` cleanup can be proved unrelated only from its retained exact completed `SEND_MESSAGE` parent. The child and parent must agree on chat, bot, remote message, completion, immutable creation time and the three-minute confirmation delay; parent source message/user must be explicit null. The parent must retain explicit null context and only its buttons or absent options, and the child must have no context or reply. Its canonical action key must match the routed Major Start producer or exact-bot Publisher Start producer. The target group must differ from every selected source chat. Any missing, truncated or unknown proof remains denied.

Publisher identity is the separately host-attested admission `publisherBotId` or stopped `binding.publisherBotId`, carried through both Redis inventories. It never enters `selection.majorBotIds`, changes owner selection/cutoff, or creates a child hold. No new queries, queue reads, mutations or MAX calls are introduced. A later diagnostic sample proves only its observation window; an older admission refusal cannot be attributed to a vanished job without contemporaneous evidence.

## Abort before installation

When a modern preparation never crossed `INSTALLING`, a reviewed corrective envelope may use `abort-before-install` with the exact runtime SHA and current journal digest. It accepts `STOPPED` without pending inventory, or `INVENTORIED` with an authenticated ordinary pending/reviewed pair, or all four pending/reviewed/superseded/refreeze-absence proofs and the complete verified original-to-refrozen evidence chain. The ordinary pair must retain its original artifact hash, ready preview, source/image/operation/selection bindings and the exact sixteen stopped generations; partial or mixed refreeze history is refused. It refuses pending recheck, seal, runtime or release evidence. Every pending artifact, original journal and superseded proof remains immutable through `ABORTING` and `ABORTED`; two fresh independent certificate-absence reads still precede restart. This abort controller pins runtime `b0d3c4e1b437127b985791ea67b7109843988fbb` and API image `sha256:e7f01f71971f7c9c6410151bfcc90d7388c8766ab6a5f919e8f30a7603e6ec2b`, with a distinct controller descended from that exact runtime commit. The separate corrective apply/refreeze identity remains pinned to its documented runtime and is not widened by this abort path. It restores the same captured 14 API and two native generations, verifies all 24 queues resumed and checks dependencies; it does not install holds, retry effects or deploy another image. Retained-preview abort journals require this compatible host tooling for subsequent operations; do not switch back to an older journal reader.

The controller records the original journal, removes its isolated client, confirms the same stopped generations and owned 24-queue fence, and performs two independent read-only primary-key checks that the exact operation certificate is absent. The fixed probe is hash-bound and runs in the frozen API image with database credentials only from the captured context and no MAX credentials. It cannot install or rewrite exclusions.

A durable `ABORTING` transition precedes restart. Only the original 14 API and two native container generations may restart; identities, owned queue resumption and dependency smokes must pass before `ABORTED` opens ordinary operations. Existing unrelated backlog may remain explicitly visible. The result reports `installed: false`, `coldRecoveryComplete: false` and no release. If interrupted, inspect the current journal and submit a newly reviewed abort request; never hand-write a terminal phase or delete evidence.
