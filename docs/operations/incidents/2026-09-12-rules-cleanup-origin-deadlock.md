# Rules Cleanup Origin Deadlock - 2026-09-12

## Confirmed Cause

A failed rules publication request at 07:23:38 UTC was resolved from a bounded nginx log window.
Targeted MAX metadata then matched the exact user-supplied group invitation. The active current
rules post belongs to one bot with confirmed group administrator access and `write` permission.
A different, older cleanup is pinned to another bot that no longer has access to that group.

The exact metadata audit showed no ambiguous send fence, a current published message bound to
the accessible bot, and an older `republish_previous` cleanup bound to the inaccessible bot.
Its linked delete intent was `OBSERVED`, so this chat used the compatibility deletion path.
MAX returned `403 access.denied` during the rules operation. Every later publish retried the
older deletion before doing anything to the current post, making the permission loss a permanent
publication blocker. Yesterday's reconciliation race fixes did not remove that dependency.

MAX lists the current post for the active bot but does not return the older ID. The direct lookup
returns generic `404 not.found`. That remains absence-or-access uncertainty, not proof of deletion.
No historical cleanup marker may be erased on that evidence alone.

## Correction

- Separate updating the confirmed current rules post from deleting a different historical post.
  While an older republish cleanup is pending, replace the current post in place with its stored
  bot. Preserve the current link and do not send a duplicate post.
- Verify the bot's fresh membership and numeric identity against the exact remote message author
  and chat before editing. Replace all draft text/media/buttons and require documented success.
- Keep the older cleanup and intent untouched. Do not change cross-bot deletion policy, rollout
  controls, or the interpretation of 403/404.
- Preserve publication CAS checks, final pre-mutation ownership checks, and ambiguous-operation
  fencing. Pending reset is not an in-place update candidate.
- Add a reviewed, preview-first operator command that uses the normal publish function with an
  exact expected revision and cannot send or delete messages.

## Verification Boundary

Local tests cover exact author and bot ownership, source publication races, old cleanup retention,
complete attachment replacement/removal, explicit MAX success, forbidden sends/deletes, and
operator preview/revision checks. The diagnostic catalog is metadata-only, key-indexed, single-chat,
read-only, and resource-bounded; its grants and query plans are tested with PostgreSQL semantics.

After green exact-SHA CI, deploy every shared API role through the normal fenced rollout. Review
the operator preview against the exact current and pending message IDs before applying the saved
draft, then verify the same current message ID remains published and the historical cleanup is
still tracked. No test posts, participant sanctions, or speculative historical deletion are needed.
