# Exact-source webhook abandonment

Use this only when an operator explicitly discards an unfinished modern webhook
source without replay. It does not establish that previous remote effects succeeded
or failed. A started execution claim and every existing action, sanction, DELETE and
ambiguous member receipt remain unchanged.

The scope is an exact outer human message in a moderated group, plus its proved
descendants. The modern owner and late-receipt inspectors accept plain text, text
with one strict official SHARE preview and no linked message, or a strict flat
forward/reply whose linked text has zero through ten validated image/photo
attachments. A reply requires outer text with no direct attachments. The original
payload must match the real webhook parser; direct, linked and composed text must
pass default and configured command checks. Bounded passive formatting and strict
credential-free HTTPS link markup add no source identity. Nested links, direct
images/video, mixed preview/media and unknown metadata are refused. These shapes
do not change the legacy recovery profile.
Only the outer recipient chat, message ID and sender identify the source;
linked identities never become held messages or people. A new outer message that
forwards the same original, and any distinct message from either participant, remain
outside the hold. Publisher is a separate observer/publisher, never a moderation executor.
Legacy member/global-user holds remain independent and cannot be repurposed for this
operation. Unsupported sources or unattributed actionable continuations are refused.

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
late-receipt profiles, including strict forward/reply/preview provenance, after
this release. The controller requires a 20 GiB Docker filesystem reserve and uses
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
keys, uses advisory `COUNT 4096`, and caps pages at 4,096 and duration at 15 seconds
inside the shared 30-second collection deadline. Structural census has separate
4 MiB namespace-reply and 16 MiB returned measurement-metadata budgets. Each
read performs at most two SCAN pages, with every cursor accounted for. Atomic read-only
transactions run three EVAL_RO commands: commandstats projection, page, projection.
Each projection validates at most 64 KiB and 512 lines of internal INFO and returns
at most 512 bytes of original counter text. Exactly two completed EVAL_RO calls
must separate the snapshots; their reported time includes the first meter and
the whole read. Above 50 ms refuses admission after execution, without retry or
preemption. The final meter is outside that delta; the 15-second wall deadline
remains independent. This reduces returned metadata, not internal INFO work.
Redis 7.2+ Lua TIME is frozen. Structural census has separate byte/key/work limits
from the unchanged effect inventory limits of 512 pages,
50,000 probes and 8 MiB. It never substitutes a `:meta`-only scan, omits an unknown
namespace or deletes queue history to make admission pass. An unknown retired
namespace requires its own reviewed retirement procedure before a fresh admission.

Run the reviewed request through:

```bash
./infra/scripts/vps-connect.sh source-abandonment /absolute/private/request.json
```

`preflight` is read-only and leaves producers running. Review its complete evidence
before `prepare`. Preparation binds the exact generations, stops all fourteen API
roles and both auxiliaries, fences all twenty-four webhook queues, and captures a
bounded stable inventory. It does not install dispositions. A refused cold preview
leaves the operation fenced; inspect the journal and use its exact recovery path.

## Installation and recovery

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
It currently pins runtime commit `9f06dff5d32d6f1bd61ee8fa92f103b043475452` and its
immutable API image. The controller itself must be a distinct, clean, exact
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

Repeated catalog measurements may have different costs. Semantic comparison
excludes only each catalog's direct `cost` field, while retaining namespace counts,
version, completion, issue and all other fields. The fresh complete inventory is
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
