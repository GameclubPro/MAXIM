# Storage lifecycle policy v1

Status: conservative implementation policy, 29 September 2026. This document
does not enable a cleaner or shorten product history. It refines S2 of the
[storage optimization plan](vps-storage-optimization-plan-2026-09-29.md).

## Decision

Retain webhook identities, execution claims and full event bodies until every
consumer below has a compatible replacement and a measured retention horizon.
Unknown age/dependency/replay bounds mean **hold**, not permission to delete.
`WEBHOOK_COMPLETED_RETENTION_ENABLED` remains false. The existing 7-day cleaner
is not the implementation of this policy: it uses receipt creation time and
deletes execution claims through the receipt FK.

Prioritize reductions in new writes that need no history deletion or schema
rewrite. Do not create another identity registry merely to duplicate the current
one: retaining the existing receipt identity and claims while separating its
body is an alternative to evaluate before S5. Neither design is activated yet.

## Consumer and field inventory

Paths below are relative to `apps/api/src`. Direct SQL consumers prevent hiding
all JSON behind an opaque compressed envelope, even if an application reader
can decode that envelope. Preserve each predicate and its partial index together.

| Data / fields                                                                              | Consumers                                                                                                                                                | Required lifetime / migration condition                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt `id`, bot-scoped `dedupKey`, `botId`                                               | `webhook/webhook.service.ts`, routing, BullMQ jobs                                                                                                       | Across intake, retries, restored queues and accepted replays; no global finite replay horizon currently proven                                |
| `type`, `updateId`, update timestamp, message identity                                     | `webhook/webhook-semantic-event-key.ts`, `moderation/webhook-canonical-execution.service.ts`                                                             | Semantic mirrors and canonical execution must agree before and after restore; retain key algorithm compatibility                              |
| Status, enqueue times, attempts, quarantine                                                | `webhook/webhook-outbox.service.ts`, `system/queue-metrics.service.ts`, canonical execution                                                              | Until all work and detached execution are terminal; terminal status alone does not prove no dependent work                                    |
| Claim `(kind, semanticKey)`, owner receipt, lease token/deadline, enforced/completed state | Canonical execution, outbox recovery                                                                                                                     | Claims currently cascade with receipt deletion; must survive any future body cleanup                                                          |
| Message IDs, sender/chat IDs, text, edit time                                              | `moderation/moderation.service.legacy.ts`, deletion guards, duplicate detection, admin cleanup                                                           | Processing, current-content guards, history windows and retries; receipt time must not replace update/edit time                               |
| `raw.message` and supported raw envelopes, forward identities, attachments, markup         | `admin/publisher-post-import-processing.service.ts`, `publisher/publisher-auto-reply-content-capture.service.ts`, private-control media/markup importers | Exact authenticated bot and receipt validation plus import/recovery; normalized text alone is insufficient                                    |
| Raw photo identity, attachment URL/token/package metadata                                  | `moderation/photo-duplicate/*`, `moderation/message-duplicate/*`, `moderation/commercial-ocr/*`                                                          | Current-message/media proof and pending guards; preserve token ownership and transient URL refresh semantics                                  |
| Callback data, user, source message, raw lifecycle payloads                                | `moderation/max-callback-update.util.ts`, release callbacks, ownership/binding lifecycle                                                                 | Callback execution, ownership reconstruction and recovery; no global TTL established                                                          |
| `message.chatId`, `senderId`, `senderName`, allowlisted `type`                             | `moderation/local-admin-contact-display-name.query.ts`, `admin/admin.service.legacy.ts`                                                                  | Local display-name fallback; migrate complete coverage to `chat_user_display_names` before removing fallback data                             |
| Message sender/chat/title plus raw `chat_type`, `chatType`, `chat`, `is_channel`           | `admin/managed-entity-candidate-sync.service.ts`, `max/max-bot-ownership-foundation.service.ts`                                                          | Managed entity discovery/repair; raw predicates still read directly in SQL                                                                    |
| Private chat identity, sender, event type                                                  | Suggestion delivery recovery and admin private-dialog lookup                                                                                             | Administrator delivery route recovery; replacement route must be durable before receipt cleanup                                               |
| `type=message_created`, chat/author/message ID, message timestamp, `(created_at,id)`       | `moderation/reports/report-execution.service.ts`                                                                                                         | All active/reopened report scan windows and cursors; retain report lookup index even when feature currently off                               |
| Binding event type, payload timestamp source, chat/user/text                               | `publisher/publisher-entity-binding-lifecycle.service.ts`                                                                                                | Bounded recovery of authenticated `bot_added` / start events                                                                                  |
| Full stored update                                                                         | `scripts/audit-commercial-filter.ts`, `scripts/repair-karavan-storefront-relays.ts`                                                                      | Operational replay/export compatibility must explicitly understand expired bodies; absence must never imply new work                          |
| Separate `rawPayload`                                                                      | Receipt sampling and canonical failure/quarantine settlement                                                                                             | Sampling applies only to this column; full `normalizedPayload.raw` remains. Failure copies are intentionally separate diagnostic writes today |

This is an inventory of the current storage boundary, not a claim that every
field may be retained for seven days. New consumers must choose an explicit
history source before payload compaction can be activated.

## Data classes and eligibility

| Class                                    | Current policy                                  | Holds and release condition                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook receipt/body and execution claim | No new age-based deletion                       | Outstanding readers, queue jobs, lease/quarantine, unknown replay/restore horizon; requires compatible body-expired state and authoritative proof |
| MAX action / delivery ledger             | Preserve existing domain policy; no generic TTL | Attempted, UNKNOWN/ambiguous, pending publication, sanction fence, UNBAN/re-BAN identity; never reset a send because history was removed          |
| Audit suggestions / publications / media | Product data, not disposable logging            | Author/bot ownership, scheduled/active/published content, visible history and delivery/review receipts                                            |
| Moderation and membership feeds          | Keep current policy                             | Source events and derived feeds need a joint history/rebuild policy; generic source deletion is not sufficient                                    |
| Sanctions / reversals                    | Keep current special retention and latest fence | Last authoritative BAN/UNBAN state survives time-based history cleanup                                                                            |
| VK imported JSON                         | Refresh changed values, reuse equal stored JSON | Same content hash is insufficient: raw counters and CDN URLs can change; active publish idempotency key freezes the revision                      |
| Unused immutable MAXIM images            | Existing manifest-aware reclaim                 | All current/retained manifests and every container; retain at least five releases; no host-wide pruning                                           |

`H = max(accepted provider replay, internal retry/recovery, restore replay,
domain history) + margin` must be established before finite proof retention.
Publisher start's one-day intake limit does not establish H for other event
types. Until H is known, proof retention is unbounded and body eligibility is
false where a consumer has no proven expiry/replacement.

## New suggestion media writes

Major image suggestions use the existing `imageStorageVersion=1` relation
reader used by Publisher. `auditLog.create` atomically creates the audit metadata
and ordered `channelSuggestionImageAssets`: validated inline bytes or the exact
trusted bot upload receipt, never both. Metadata retains image count/names;
`mediaBotId` remains on the owning audit row. No cross-author or cross-bot dedupe
is introduced. Video formats and legacy token-video handling stay separate.

Async delivery/publication reads relation media; inline fallback still receives
the accepted media in memory. List mapping reads bounded filename metadata
without loading image bytes. Legacy JSON remains readable. Missing relation
rows in a versioned payload fail closed instead of silently sending text only.

Do not backfill old audit rows yet. Migration needs a snapshot/CAS check against
concurrent review/delivery edits, verified reader parity, restore evidence and
measured temporary capacity. Moving JSON bytes to `bytea` does not itself return
existing table files to the filesystem.

## Index passports and physical reclaim gate

| Index family                                                    | Reason to retain / required evidence                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook primary/dedup keys                                      | Global receipt identity and intake dedupe; never remove as a storage shortcut                                                                                              |
| Status/created, status/next-enqueue/created, bot/status/created | Different ordered queue/retry/bot access paths; matching leading columns do not prove redundancy                                                                           |
| Ordered chat head and timeout quarantine partial indexes        | Queue ordering and crash quarantine; exact partial predicate is part of correctness                                                                                        |
| Execution kind/semantic key, event/kind, status/lease           | Unique side-effect fence, receipt claim lookup, lease recovery; retain all semantics                                                                                       |
| Report history and local display-name indexes                   | Product/repair consumers above; zero scans is insufficient for removal                                                                                                     |
| VK source/last-seen index                                       | Import freshness metrics use observation time; suppressing all unchanged-post UPDATEs would make freshness stale                                                           |
| Catalog-reported equivalent index group                         | Compare keys/includes, opclasses, collation, order, predicate/expression, constraint/replica identity and workload; choose only a non-authoritative duplicate after review |

No database DELETE, index DROP, REINDEX or full-table rewrite is authorized by
a size report alone. Before apply: fresh operation-specific free-space budget,
tested restore, bounded lock/WAL/time envelope, healthy runtime, shared deploy
lock and a concrete rollback. Restore tests run with all external dispatch
disabled and cannot re-enable sends from an old queue snapshot automatically.

## Acceptance gates still outstanding

1. Fresh full backup and isolated restore with measured RPO/RTO and enough space.
2. Field-level fixtures/shadow parity for a compact webhook format and direct SQL.
3. Proof/holds protocol with real PG16 replay, crash and concurrency coverage.
4. Preview/observe maintenance sessions before the first destructive body canary.
5. At least seven complete observation days before a sustainability claim or an
   unattended cleanup schedule. No elapsed window is inferred from unit tests.
