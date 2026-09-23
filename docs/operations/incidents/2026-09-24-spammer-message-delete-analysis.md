# Spammer Message Deletion: Complaint Analysis And Delivery Plan

## Evidence Boundary

The complaint shows the same recruitment advertisement with a plain HTTPS `vk.me`
contact link and a link preview in two MAX clients/accounts. This makes a
single-client display/cache problem less likely; it does not prove the server's
message state, the sender's registry status, or any bot action. The screenshot
contains no usable chat/message ID, calendar date, bot identity, policy snapshot,
or deletion receipt. Do not identify a MAX sender by display name or by the VK
destination: those can represent different people.

No specific production message has been attributed or repaired. Current health
checks cannot establish the cause of a historical missed deletion. A repository
defect is not proof that the reported message took that code path.

## Findings

1. The existing known-spammer, detected-spammer, and local-block message paths
   already request deletion before kicking. The blanket hypothesis that registry
   enforcement never deletes messages is incorrect.
2. Fanout detection detached delete-and-kick work and immediately returned
   `handled: true`. A persistence failure could be logged after the webhook had
   completed and after ordinary link checks had been skipped. A process shutdown
   could also interrupt that unowned work before an intent existed.
3. The shared message sanction claim suppressed inline deletion on retries. The
   execute-mode durable intent was already persisted before that claim, so its
   recovery remained available; the loss is particularly relevant to legacy/off
   and shadow inline execution. Claims are not MAX deletion receipts.
4. Known-spammer handling returned success even when deletion failed or was
   rejected. Local-block handling used the kick result as the message-handled
   result. Both could skip independent link checks while the message remained.
5. The developer-forced early-return path similarly ignored deletion acceptance.
   Its stronger enforcement must remain separate from ordinary admin exemptions;
   unsuccessful deletion now reaches webhook retry rather than falling through
   an admin exemption or being acknowledged.
6. The displayed URL form is supported by the existing detector. Regression tests
   cover HTTPS and bare-host forms, restrictive policies, explicit domain
   allowlisting, and non-enforcing policy. A link preview is not evidence of an
   extraction bug. Actual webhook markup/share evidence is still needed for this
   particular message.
7. A membership join event can authorize excluding a known spammer without
   identifying any authored message. Its service message ID must never be used
   as authority to erase arbitrary chat history. No history sweep was added.

## Implemented Plan

- Separate budgeted observation/policy work from enforcement. A tracking decision
  is not completion; delete intent persistence and enforcement are awaited by the
  owning webhook outside the observation timeout. Late observations cannot start
  detached sanctions after that timeout.
- Persist the existing durable intent, attempt its deletion independently, then
  use the existing claim to deduplicate only the kick. Preserve remote-action
  idempotency, cross-bot routing, source timestamps, and durable retry ownership.
- Derive message handling from deletion acceptance, not kick success. Pending
  durable work is accepted but is not reported as remote deletion confirmation.
  Rejected ordinary spammer deletion leaves independent content checks available;
  unsuccessful developer-forced deletion raises for bounded webhook retry.
- Add focused handler, full message-pipeline, fanout handoff, persistence failure,
  timeout, duplicate-claim, and link-policy regression coverage. Keep existing
  disabled-toggle, exemption, routing, and intent-recovery tests.
- Validate repository static checks and the API suite/build, then require green
  exact-SHA CI and deploy only the shared API component with all its roles. No
  schema migration, static frontend release, policy activation, or historical
  deletion is part of this change.

## Exact Incident Follow-Up

Obtain the chat ID, message ID or resolvable message link, calendar date/time and
timezone, and bot identity. Review the authenticated receipt and exact message
through approved bounded diagnostics. Correlate effective chat settings, sender
identity, exemptions, active registry decision, semantic claim, deletion intent
and attempts, kick ledger, actual bot permissions, and MAX response. Distinguish
missing receipt, policy exemption, failed dispatch, pending retry, confirmed
absence, and an independently confirmed remaining message.

Use the existing preview-first missed-delete repair only after the exact target,
current authority, and its query scope have been reviewed. Do not run a fleet
scan or delete the screenshot's message based only on its visible text. A kick
alone, a generic HTTP 404, or a successful API health probe is insufficient proof
of message absence. Preserve the existing documented success/absence classifier.

The current official MAX deletion documentation specifies administrator/delete
permission and a per-chat deletion limit of two messages per second. Respect the
existing critical-lane queue and rate controls; do not add ad hoc direct calls or
sleeps. Source: <https://dev.max.ru/docs-api/methods/DELETE/messages>.
