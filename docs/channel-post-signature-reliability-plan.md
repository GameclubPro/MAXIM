# Channel Post Signature Reliability

## Scope

The Major channel setting owns a text signature or a CTA button. Publisher consumes the CTA
through its exact-bot dialog context; its publication runtime deliberately does not append
Major-owned text. Do not widen Publisher credentials or authorize forwarded-post replacement
without a verified administrator. Existing posts are not bulk rewritten by a settings update.

## Delivery Recovery Hardening

### Durable post scheduling

The parent channel's next visit follows its earliest retained post, including an unvisited
sibling after an exact source read fails. A channel with only future retries does not consume
a due-channel slot. Receipt capture and the parent wake-up share the existing transaction:
only a newly inserted post wakes the parent; mirrors retain the saved post retry and horizon.
Parent-before-child locking prevents a concurrent idle transition from losing that arrival.
Scoped MAX cooldowns, the governor, per-tick budgets and final mutation guards still apply.

An exact source GET returning 404 or a locally validated missing identity remains ambiguous.
For a post at least five minutes old, retain the hint and delay its next read by five minutes,
bounded by the original expiry. A reservation CAS preserves PostgreSQL timestamp precision
and prevents a late failure from overwriting a newer attempt. Fresh failures, 403, 429, server
errors and mutation failures keep their existing handling. This never proves deletion,
restores access, settles a webhook or authorizes replay of an uncertain action.

The read-only `infra/scripts/channel-decoration-audit.cjs demand <channel-id>` mode reports
the exact parent's schedule, at most 64 retained posts and at most 64 due-channel heads with
explicit truncation. The fleet sample exports no channel identities. Use the existing bounded
admin audit transport and shared PostgreSQL audit lock; it verifies indexes and plain plans
before reads. Scheduling timestamps are not ingress, dispatch or delivery receipts. Correlate
them with the existing closed `chat-message-window` report and independent MAX readback.

The follow-up audit found additional code-level failure paths. These explain how an enabled
setting can coexist with unsigned posts, but are not attribution to a particular complaint
without that channel/post identity.

1. **Released edits could never retry.** The durable marker only admitted proven pre-dispatch
   failures; a timeout, 429, 5xx, preparation failure, or process crash left other attempts
   permanently `IN_PROGRESS`. Persist `edit_message` at claim time for ordinary in-place
   edits. Reclaim only released/expired edit leases using compare-and-set and revalidate claim
   ownership immediately before PUT. Unknown old outcomes and send/replacement fences remain
   non-replayable. A late worker cannot overwrite a newer claim.
2. **The background repair excluded signature-only channels.** Extend the existing bounded
   recovery sweep to eligible signature channels and retryable edit intents. Reuse the final
   locked MAX GET to prepare text, including senderless posts. Preserve current settings,
   source formatting, media, custom buttons, and Publisher discussions. A proven pre-dispatch
   signature failure can use the same guarded edit path; it never authorizes replacement.
3. **New webhooks hid older missed posts.** Only an ordered scan advances its contiguous
   cursor. Webhooks schedule a repair without moving that cursor or indefinitely extending
   its deadline. Run durable recovery even when no normal channel scan is due.
4. **Stale text could fail or falsely finish before the fresh GET.** Ordinary edits prepare
   the signature exclusively inside the message-edit lock, including already-signed input
   and length validation. Re-read settings there so a disabled signature is not appended
   from cached preparation. Recognize `body.caption` and its markup as well as `body.text`.
   Forwarded snapshots cannot silently turn a recovered edit into a replacement operation.
5. **Activation did not verify edit permission.** Enabling the module now requires a fresh
   MAX edit-permission check on an executable Major route. Posting-only access is insufficient;
   a confirmed eligible standby succeeds even if another probe fails. Check outside the
   database transaction and distinguish temporary lookup failure from missing permission.

### Resource And Safety Limits

- No new worker, timer, schema migration, bot credential, or fleet-wide MAX lookup.
- Existing governor, per-bot budgets and edit locks still apply. The recovery sweep remains
  at most once per five minutes, seven days of recorded intents, 100 candidates, and three
  mutation attempts per sweep with at most one per channel.
- The normal missing-webhook scan still inspects the latest ten posts; durable intent recovery
  also covers admitted failures that have left that window. This is bounded recovery, not a
  guarantee against an arbitrarily long complete webhook outage.
- `enabled` remains configuration, not a delivery receipt. Rights revoked after activation,
  absent posts, permanent MAX validation failures, and governor pauses can still prevent or
  delay decoration. No silent truncation, implicit button fallback, or bulk history rewrite.
- Existing `message_edited` events do not reopen completed post intents. Automatically restoring
  an intentionally removed signature needs a separate product policy and revision-aware
  ownership; this release does not silently redefine manual editing.
- The general settings timestamp still bounds never-admitted historical scan candidates.
  Recorded edit intents recover independently of that timestamp. A dedicated activation epoch
  and paginated outage reconciliation require a separately reviewed schema/index rollout.

### Acceptance And Release

- Regression coverage uses persisted markers, not just mocked claim success: timeout/retry,
  stale lease, obsolete-worker fencing, send/reply exclusions, signature-only recovery,
  newer webhook versus earlier missed post, current captions/settings, and activation rights.
- Run focused signature, channel decoration/recovery and MAX transport tests, API typecheck,
  full API impact checks, refactor guards, formatting and diff checks.
- Submit only owned files, require green exact-SHA CI, deploy the shared API roles, then run
  strict health/OCR smokes. No static rebuild or Postgres/Redis recreation is required.

## Earlier Hardening

1. A partial settings update validates individual fields but throws an unhandled Zod error when
   the merged button label exceeds 32 characters. Validate the merged state as a client error.
2. Read/merge/write outside the transaction loses independent concurrent settings updates.
   Serialize the final merge on the parent channel row; keep remote link resolution outside
   the database lock and fail with a conflict if concurrent edits invalidate that preflight.
3. Switching presentation only changes the UI draft. Persist a valid mode change immediately,
   validate drafts before requests, and reconcile the latest ref with the saved response.
4. Auto-decoration passes webhook/poll text to an edit that already fetched a newer post.
   Prepare text from the fresh snapshot inside the existing distributed edit lock. Button-only
   updates must omit text; quick-button transformations retain their source-content guards.
5. Exact HTML suffix comparison disagrees with MAX markup rendering for quoted labels,
   apostrophes, repeated whitespace and escaped URL attributes. Render signatures through the
   same MAX markup serializer and cover the round trip with regression tests.
6. CTA preparation runs after claiming a durable marker but before its error handler. Move it
   into the protected operation so transient failures release the marker for retry.
7. Auto-decoration link lookup can select a different bot from the already authorized editor.
   Carry the resolved bot identity through text and button preparation.
8. Trimming the whole base post removes authored leading whitespace. Trim only the trailing
   separator area when appending a signature.

## Cost And Concurrency

- Reuse the MAX GET already performed under the edit lock; no additional network read is needed.
- Ordinary edit preparation now runs only on the fresh snapshot; it does not reuse cached
  settings even when the event text happens to match.
- Send only changed settings fields. Rebase edits made during an in-flight save over the server
  response, retaining concurrent changes to other fields and server normalization.
- No-op settings writes do not advance the shared settings timestamp used by the recovery scan
  and do not add redundant audit rows.
- Keep the new text-mutation logic in `channel-auto-post-runtime.ts`, below the legacy facade's
  existing size ceiling. No schema migration, new worker, polling loop or global cache is added.

## Validation And Release

- Focused settings, signature, MAX edit and channel auto-post regressions.
- Mini app field validation and save behavior, including delayed responses and mode changes.
- API and mini app impact validation, production bundle, refactor guards and diff checks.
- Local browser checks on narrow mobile and desktop layouts with mocked transport.
- Staged-only submission, green exact-SHA CI, shared API and canonical mini app deployment,
  then strict production health/static smokes. Never recreate Postgres or Redis.

## Remaining Product Decisions

- Anonymous forwards cannot safely use text-replacement fallback; button mode is independent.
- Oversized signed text fails explicitly without truncating authored content. A product-approved
  optional button fallback would change the selected presentation and is not implicit.
- Editing/removing signatures on historical posts needs explicit ownership/revision metadata
  and a separately reviewed bounded migration, not suffix-based deletion of user content.
- A native MAX editor can still race between the final GET and PUT because the remote API has
  no documented conditional-edit revision. The shared bot lock only serializes bot mutations.
