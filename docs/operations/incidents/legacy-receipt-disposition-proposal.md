# Positive legacy receipt dispositions

The minimal recovery implementation adds per-receipt abandonment evidence, an explicit
`NO_REPLAY_HELD` operational status, bounded materialization and exact readback.
Production activation remains disabled until the separate cold controller proves the
stopped compatible fleet, finite reviewed inventory and restart authorization.

## Evidence and operational status

A sealed authority binds the exact certificate, source SHA, image identity, attestation
and approved preview. An immutable disposition binds one receipt to that authority,
its original status, original metadata, payload digests and claim snapshot. A nullable
composite receipt pointer cannot borrow another receipt's proof. A scope match alone
cannot remove work from ordering or lag.

The original unknown owner retains `FAILED`, original error and all claim evidence;
only its exact positive pointer releases ordering. Other positively validated held
receipts transition to `NO_REPLAY_HELD`. They are never marked executed, processed or
duplicated. A database trigger preserves every other source field and makes the
projected receipt immutable. Dispositions survive eligible body retention as tombstones.

The enum addition is a separate migration because PostgreSQL cannot use a newly added
enum value within the same transaction. Two nullable projection columns and `NOT VALID`
constraints avoid a retained-history rewrite or validation scan. The new status reuses
existing status/age indexes for lightweight health and retention. Materialization uses
the exact existing ordered-chat partial-index expression and predicate. There are no
new indexes on the retained webhook table and no runtime epoch/BOOT framework.

## Materialization and readback contract

`materializeLegacyReceiptDisposition` returns `NOT_HELD`, `BLOCKED_UNKNOWN`,
`APPLIED_WITH_PROOF` or `ALREADY_APPLIED_SAME_PROOF`. It locks the exact receipt and
relevant execution/command claims, validates persisted source provenance, installs
immutable evidence and updates the operational pointer in one transaction. Zero-row
CAS never means success. Existing proof is re-read against its original source digest.
Started, completed or leased claims remain blocked.

Ingress materializes newly held receipts inside receipt persistence. Existing receipts
can materialize lazily during canonical preparation, before engine or local effects.
Pre-seal lazy projection requires the strict ordinary original-message validator and
per-chat custom-command rejection. Unknown sources, pre-seal commands and unsupported
shapes keep their ordering fence. New post-seal held commands follow the explicitly
approved permanent suppression policy. Original unknown owners install only through
the cold operation; normal runtime cannot manufacture their abandonment authority.

`materializeLegacyHeldReceiptPage(prisma, certificateId, chatId, pageSize)` handles
1..200 receipts per durable keyset page over the fixed sealed horizon. It is restricted
to finite original-owner chat scopes and stops at the first held but unverified source.
The lifetime original-owner bound per chat is 200. This bounds retained FAILED owner
prefixes in the existing ordered index. A complete owner-chat cursor does not claim
all chats of a globally held user were inventoried or materialized.

`readLegacyRecoveryInstallation(prisma, certificateId, expected)` accepts exact
`sourceSha`, `imageId`, `previewSha256`, `recoveries` and `children`. It returns
`ABSENT`, `UNSEALED`, `INVALID`, `SEALED` or `MATERIALIZED`, plus `completeChats` and
`requiredChats`. In a repeatable-read transaction it reconstructs the approved preview
from current original owner/claim evidence, verifies each positive owner proof and
checks the finite original-chat cursors. A lost commit response is reconciled with
this readback, never with counts alone. Partial or mismatched evidence cannot authorize
restart. `MATERIALIZED` covers only reviewed original chat scopes; raw readiness after
restart remains authoritative and may stay false while other receipts drain lazily.

## Retention and final effect boundaries

Retention alternates completed and positively held pages within the existing shared
one-page cleanup budget. Each held page selects at most 500 IDs using the existing
status/created/id index, then locks only those IDs with `SKIP LOCKED`. It removes only
post-seal bodies with exact positive proof and no owned claim. Original owners,
pre-seal evidence and all proof tombstones remain pinned. Error markers and broad
scope membership never authorize deletion.

Permanent source, participant, global-user and exact-child holds remain mandatory
before local state changes and final MAX effects. Those downstream checks and the
cold host journal/controller are separately owned release prerequisites. No MAX
smoke may mutate a live user chat while production is unhealthy.

## Native regression scope

Disposable PostgreSQL 16/Redis 7 regressions cover receipt persistence, actual outbox
selection and preparation, real SystemMode/readiness, immutable proof and retries,
borrowed-pointer rejection, pre-seal commands, nine mirrors/edits, future source times,
bounded same-timestamp pages, exact readback, global-user lazy projection, retention
locking/budgets and a 10,000-chat catalogue. Health EXPLAIN checks exercise the existing
index with 5,000 positively held receipts. These tests start no moderation/MAX worker;
independent work is proven at preparation, not at remote transport acceptance.

The emergency admission fix preserves configured capacity only for automatic,
non-manual `queue_backlog` degradation. It preserves raw readiness and unknown
ordering fences and does not itself abandon any original event.
