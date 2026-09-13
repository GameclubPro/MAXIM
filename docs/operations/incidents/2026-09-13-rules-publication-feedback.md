# Rules Publication Feedback - 2026-09-13

## Confirmed Behavior

The reported group still referenced the same bot-authored rules post created on August 30.
Targeted MAX reads returned that post successfully. Repeated successful operations updated its
contents but did not append messages to the latest chat history. The visible pinned rules were a
different, user-authored post; neither its ownership nor its pin should be changed by this fix.

The September 12 fallback deliberately edited the current post while inaccessible historical
cleanup remained pending. However, the API response did not distinguish this edit from a new
publication. Both the miniapp toast and the private confirmation always said "rules published".
The same historical link was consequently sent after each edit. That feedback misrepresented the
operation and gave administrators no explicit way to request a fresh visible message.

## Correction

- The rules request accepts explicit `new_message` or `update` modes. Omitted mode retains legacy
  behavior for older clients; it does not silently become a new send.
- The miniapp defaults to "New post" and exposes "Update post" separately. The private bot's
  publish command explicitly requests a new message.
- A new-message request appends exactly one post using the current executable bot, preserves
  older posts and the user's pin, and retains any historical republish cleanup. It never resets
  a pending deletion or an ambiguous send fence.
- Explicit update edits only the exact current bot-authored post. It cannot fall back to sending
  a new message if that post is unavailable.
- Successful responses include `operation: created | updated`. The miniapp, private confirmation,
  and private-control screen use the actual operation. Old-response fallback compares message IDs
  instead of guessing from the selected button.
- A missing link for a new post no longer falls back to the previous post URL in the miniapp.
- Autofill preparation updates text, format, and the synchronous draft reference together, so a
  fast save receipt cannot mistake its own normalization for a newer administrator edit.
- An unexpected chat or old message ID in a new-send receipt remains ambiguous and produces no
  success confirmation or automatic retry.

## Cost and Verification

No schema migration, history scan, per-chat polling, additional cleanup worker, or runtime pin
lookup is introduced. The operation is carried in the existing request and receipt; the new-post
path reuses normal send routing and rate limits without retrying inaccessible historical deletion.

Coverage includes request/receipt validation, compatibility, new versus existing message IDs,
cleanup retention, wrong-target receipts, reset/send fences, both confirmation surfaces, preview
transport behavior, and browser clicks for both commands. Mobile screenshots check the footer at
Android and small iPhone sizes with the existing MAX bridge shim.

Deployment must include the shared API and contract consumers. Production confirmation should
check exact-SHA CI and runtime readiness; do not manufacture a new group post or touch a user's
pinned message merely to validate a success label. An administrator can deliberately publish a
fresh rules message with the explicit new-post command.
