# Night-mode delivery and recovery

## Product behavior

Night mode restricts new non-administrator messages in chats through moderation. It does not
change MAX's native write permissions. Manual closure and the daily schedule are independent;
lifting one restriction must not announce an open chat while the other still applies.

The owner confirmed on 29 October 2026 that enabled opening notices are independent of closing
notices. A failed, ambiguous or unrecorded closing send, an obsolete Redis session, or a failed
closing-message deletion must not prevent an otherwise authorized opening notice. Preserve the
separate stored notification switches and the two-hour maximum opening catch-up age. Never
retry an uncertain SEND to make a transition appear complete.

## Durable obligations

- An ordinary stale transition persists reconciliation before completing and removing its SQL
  registry row. Retiring both daily jobs must leave a durable path to the next cycle.
- Effective membership eligibility changes enqueue reconciliation in the same database
  transaction. Capability or activation changes must not depend on an in-memory callback.
  Refreshes that preserve eligibility do not create extra requests.
- Versioned recovery payloads in the existing scheduled-job registry retain independent event
  persistence and close-notice cleanup obligations when Redis jobs disappear. Event recovery
  verifies the exact chat/session and accepted send receipt; it never sends another notification.
- Opening and closing keep their existing logical SEND idempotency keys. Only a matching
  successful terminal ledger receipt proves delivery. An absent event or receipt is not proof
  that the message was never sent.
- Cleanup preserves current settings, session, selected executor and lease guards. A new night,
  changed schedule, missing exact message authority or unknown outcome never authorizes deletion
  of an older session's message. A matching persisted closing event with its original bot can
  authorize cleanup when the ledger has expired; it cannot authorize another SEND or reconstruct
  an unproven event. A cleanup failure remains separately recoverable.
- If both the closing receipt and exact closing event are absent, cleanup has no proven target
  and performs no effect. Completing that no-op does not establish that CLOSE was delivered or
  never attempted, and does not create a manual alarm for an opening-only schedule.
- A scheduled opening checks the effective manual restriction immediately before dispatch.
  A manual opening command stores its truthful response from the post-update settings under
  the same command-order lock; it does not disable the night schedule.

## Investigation

Record the exact complaint time, chat, bot, expected transition and relevant component image in
the private incident record. Check settings, route eligibility, durable intent, execution and
accepted SEND separately. Current settings cannot establish historical intent after an edit.

The reviewed `night-mode:audit-close-notices` command runs in `api-admin` without MAX requests or
mutations. Use bounded keyset pages and `--sample-limit 0` for aggregate-only reporting. A complete
close census does not cover opening-only settings, prove Redis payload health or prove delivery
of future jobs. Historical same-day incidents may predate the current container's log window.

Do not repair a missing result by clearing queues, removing manual-review fences, changing bot
assignments or replaying an ambiguous send. Preserve unknown outcomes and report missing evidence.
No diagnostic messages or permission probes belong in customer chats.

## Validation and rollout

Run focused runtime/delivery/processor tests and the native night-mode and GROUP-command suites
through the public wrappers. Native cases must cover both retired jobs, crash after durable
handoff, loss of a Redis job, current-setting changes and independent progress with a fenced
closing effect. Preserve exact PostgreSQL/Redis coverage and skipped cases in the task record.

Deploy the shared API only after exact-SHA Required and CodeQL checks. The normal stopped-worker
deployment boundary installs compatible readers before new recovery work executes. Both API
rollback paths and connector bootstrap require the independent night-mode recovery reader;
turning notifications off does not make an older reader safe. Recheck the selected image across
all API roles and native auxiliaries, strict smokes and the bounded audit after deployment.
