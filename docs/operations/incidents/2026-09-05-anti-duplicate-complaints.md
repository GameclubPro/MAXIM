# Antiduplicate Complaints Audit - 2026-09-05

## Status

Corrective release prepared. Production was healthy during the read-only investigation. Photo
matching remains globally observation-only; no enforcement cohort was enabled as part of this
work.

## User Impact

- Ordinary short replies could enter text duplicate history and be deleted or escalated even when
  they carried little spam signal.
- Strict near matching discarded short negations and raw numbers, so materially different messages
  could receive the same fingerprint.
- Equal visible text with different hidden markup, button, or share targets could be treated as the
  same exact message.
- Distinct transferable attachments or forwarded content with the same caption could be treated as
  the same text duplicate even though no canonical attachment identity was compared.
- Delayed webhooks were counted by processing time rather than trusted MAX event time. An old event
  could therefore contribute to a current duplicate window.
- A stale local administrator roster could let text duplicate enforcement proceed without an
  authoritative access check.
- Critical WARN/MUTE/BAN work could outlive the awaited webhook path, allowing the event to finish
  before the sanction had completed.
- The settings poll could replace an unsaved draft, and structurally equal button arrays could show
  a false unsaved-change state.
- Oversized photo responses consumed every configured queue attempt even though retrying could not
  make the response smaller.

## Production Evidence

The bounded read-only observation covered approximately four hours:

- all 13 API roles were running without restarts; PostgreSQL and Redis were ready, and observed
  webhook lag was zero;
- 166 photo-analysis jobs covered at least 49 chats;
- 17 photo matches appeared in nine chats, all with `enforce=false`;
- the photo enforcement cohort was empty;
- historical photo failures included 23 connection timeouts and 12 oversized responses; oversized
  jobs exhausted all five attempts;
- no current Redis or delete-intent persistence failure was observed for text duplicates;
- 142 `duplicate-state throttled` diagnostics came only from chats where Antiduplicate was disabled,
  so that signal was misleading rather than evidence of dropped enabled-state work.

These are bounded observations, not whole-table totals. No message text, user identifier, chat
identifier, token, or raw payload was retained in this document.

## Root Causes

1. The text eligibility guard had been broadened from the earlier conservative spam-signal policy
   to nearly every two-character message.
2. Fingerprints covered normalized visible text but not every structured navigation target, and
   fuzzy normalization removed semantically important short tokens and numeric values.
3. Rolling Redis membership used server processing time for both retention and comparison. A first
   event could also expire or be pruned before a later accepted out-of-order delivery needed it.
4. Duplicate enforcement did not repeat the administrator check when the first check fell back to
   a potentially stale local roster.
5. Sanction execution and optional explanation delivery shared one detachable follow-up.
6. Settings hydration treated every successful poll as permission to replace local state.
7. The photo downloader reported a deterministic byte-limit violation as an ordinary retryable
   error.

## Corrective Actions

- Restored conservative text eligibility for ordinary messages while retaining short URLs, phone
  numbers, commercial markers, structured navigation, and non-service slash payloads as strong
  signals.
- Added normalized targets, aliases, and a navigation-only action fingerprint to exact identity;
  same-link mode remains target-oriented. Strict near matching now preserves Russian negations and
  raw numeric tokens.
- Moved rolling-window comparison to trusted event timestamps and isolated the new state under the
  `dup:v6` namespace. The bounded Lua mutation records reverse receipt order but counts only the
  current event and its chronological predecessors for enforcement, so a later event cannot make
  an out-of-order original actionable. Physical pruning uses Redis time, and retention covers the
  comparison window plus the maximum accepted lateness and clock skew.
- Skip duplicate state and actions when an event is older than its configured flow window or more
  than 60 seconds ahead of the server clock. Delayed events still run when they remain inside the
  configured window.
- Exclude photo, video, file, voice, media-batch, and forwarded content from text duplicate
  tracking until a canonical cross-bot attachment identity exists. Edits still write a tombstone
  that removes an earlier text fingerprint; photo analysis continues independently.
- Recheck unresolved administrator access through MAX before text duplicate deletion or sanction;
  unresolved access fails open and schedules roster refresh.
- Await critical WARN/MUTE/BAN execution. Only the optional explanation may detach. A persisted
  `action=NONE` record no longer masquerades as a terminal successful sanction. Duplicate BAN
  retries only proven pre-dispatch transient failures; ambiguous attempts remain fenced. A MUTE
  that reached neither durable event storage nor the active-state cache also requests retry.
- Preserve dirty settings drafts across polling, compare structured settings by value, clear the
  raw window input on discard, and preserve text matching fields omitted by older clients.
- Centralized the duplicate ladder calculation so mini app, private control, API rules, and
  contracts preserve valid threshold-20 configurations without hidden normalization loss.
- Made published rules preset-aware, excluded disabled duplicate sanctions, and advertised photo
  enforcement only when the effective runtime mode can enforce it.
- Marked photo byte-limit failures unrecoverable and release their ordering state immediately.
- Added a fixed `postgres-audit duplicate` catalog report with capped indexed samples, completeness
  markers, identifier-free output, and exact column-only grants for the newly inspected tables.

## Rollout Boundary

Photo enforcement stays in global `shadow`. The existing promotion plan requires approved exact
chat IDs, an independently reviewed corpus, and multi-day quality gates. The observed matches alone
cannot establish false-positive safety and do not authorize deletion.

## Residual Work

- Distinct messages or successive edits with the same timestamp still need a deterministic ordered
  ingestion identity shared by semantic webhook deduplication and Redis revision state.
  Timestamp-only ordering cannot safely choose the later payload.
- Transferable content is deliberately excluded from text matching. Restoring caption-based
  matching requires stable cross-bot identities for photo, video, file, voice, and forwarded
  content; photo enforcement remains governed by its independent rollout gates.
- An administrator is rechecked after the current fingerprint mutation. Enforcement is blocked,
  but removing that administrator's fingerprint safely requires an atomic compare-and-remove Redis
  operation or a two-phase state commit.
- Full settings `PUT` has no expected revision. The draft is no longer erased by polling, but two
  administrators can still overwrite one another; optimistic concurrency requires an API contract
  change.
- Optional explanation delivery remains non-durable. Critical deletion and sanctions do not depend
  on it.
- Unit coverage exercises the bounded Redis script contract, but no local integration test runs the
  new Lua window against a real Redis/BullMQ pair. Production observation remains part of rollout
  verification.
- The `dup:v6` retention horizon is intentionally longer so accepted out-of-order events remain
  comparable. Monitor Redis memory after rollout and investigate growth before changing the
  bounded history or enabling any broader enforcement.
