# Exact-source webhook abandonment

Use this only when an operator explicitly discards an unfinished modern webhook
source without replay. It does not establish that previous remote effects succeeded
or failed. A started execution claim and every existing action, sanction, DELETE and
ambiguous member receipt remain unchanged.

The scope is an exact original human text message in a moderated group, plus its
proved descendants. A distinct new message from the same participant remains outside
the hold. Publisher is a separate observer/publisher, never a moderation executor.
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
readers before any installation. Both rollback paths require these readers after
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
