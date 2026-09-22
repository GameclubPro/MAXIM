# Channel Post Signature Reliability

## Scope

The Major channel setting owns a text signature or a CTA button. Publisher consumes the CTA
through its exact-bot dialog context; its publication runtime deliberately does not append
Major-owned text. Do not widen Publisher credentials or authorize forwarded-post replacement
without a verified administrator. Existing posts are not bulk rewritten by a settings update.

## Confirmed Defects And Implementation

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
- Reuse prepared text when that exact text and format still match the fresh snapshot.
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
