# Exact-source webhook abandonment

Use this only when an operator explicitly discards an unfinished modern webhook
source without replay. It does not establish that previous remote effects succeeded
or failed. A started execution claim and every existing action, sanction, DELETE and
ambiguous member receipt remain unchanged.

The scope is an exact outer human message in a moderated group: original plain text
or one strict flat forward with text and zero through ten validated image/photo
attachments in the linked message, plus its proved descendants. The existing
`inspectLegacyForwardText` validator must prove the parser-composed text and reject
commands in the direct, linked and composed text, including configured triggers.
Direct attachments, replies, nested forwards, video and unknown metadata/media are
refused. Only the outer recipient chat, message ID and sender identify the source;
linked identities never become held messages or people. A new outer message that
forwards the same original, and any distinct message from either participant, remain
outside the hold. Publisher is a separate observer/publisher, never a moderation executor.
Legacy member/global-user holds remain independent and cannot be repurposed for this
operation. Unsupported sources or unattributed actionable continuations are refused.

`sendAutoDelete` consumes its parent SEND authority, so its exact original-source
envelope and parent key remain part of the exclusion. `BOT_MESSAGE_AUTO_DELETE`
from a separately authenticated bot-message webhook has its own message-scoped
claim, current chat policy and origin-only bot routing. It does not consume the
abandoned human execution claim; this operation does not suppress that independent
policy.

## Preparation

Use a clean checkout at the exact reviewed runtime SHA with every API role and both
native auxiliaries running that image. Deploy the additive schema and mandatory
readers before any installation. Both rollback paths require these readers and the
strict forward provenance validator after this release. The controller requires a 20 GiB Docker filesystem reserve and uses
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
read performs one SCAN page, with every cursor accounted for. Atomic read-only
transactions run three EVAL_RO commands: commandstats projection, page, projection.
Each projection validates at most 64 KiB and 512 lines of internal INFO and returns
at most 512 bytes of original counter text. Exactly two completed EVAL_RO calls
must separate the snapshots; their reported time includes the first meter and
the whole page. Above 50 ms refuses admission after execution, without retry or
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

Restart follows positive seal/materialization proof. Verify all fourteen API roles,
both native auxiliaries, released queues and fresh database/Redis health. A finite
operation may complete while other chats still have backlog; report that readiness
result honestly. Final deployment acceptance still requires strict release smokes,
fresh completed receipt cohorts and independent progress. Never hand-write a release
manifest or replay an abandoned source to make readiness green.
