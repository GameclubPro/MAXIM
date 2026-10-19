# Agent incident delivery review, 19 October 2026

The blocked-chat incident remained unresolved while recovery tooling, validation and evidence
preparation expanded. The working process must shorten the path to a verified user-facing recovery.
This review changes agent instructions; it does not claim that chat recovery is complete.

## Evidence and limits

A bounded local review of the existing operation request/completion metadata found 491 launches
and 490 terminal records at the audit cutoff. Fourteen commit/push attempts accounted for 240.39
of 492.57 summed operation-minutes; 127.33 of those minutes were failed or interrupted attempts.
Operations overlap, so these sums are not calendar delay or proof that every diagnostic was waste.
Private operation records and production identifiers remain outside Git.

Five attempts at one native commit/push stage took 136.14 summed minutes: 99.89 in the first four
failed/interrupted attempts and 36.25 in the successful fifth. Two separate interrupted broad API
checks added 14.19 minutes. The principal avoidable rework was late validation of test selection,
fixture compatibility and command forwarding. A subsequent one-line malformed-JSON test fixture
triggered CodeQL and required a roughly fourteen-minute helper repeat and new exact-head CI.
The fixture was corrected without suppressing the analyzer.

The task record also retained an earlier RUNNING validation beside its later completion and a
remaining-CI field from the preceding SHA. Such contradictions make resumption slower and can
cause duplicate work. Healthy API/store samples coexisted with fresh events waiting behind old
blockers; infrastructure health did not establish recovery of the affected chats.

## Implemented changes

The root agent entry now routes incidents to the existing execution guide. Its
[incident delivery rules](../development-reliability-plan.md#incident-delivery) require:

1. One next recovery result, blocking gate and executable action; unrelated improvements become
   follow-up work. Every new diagnostic must resolve a named gate.
2. Effective public CI test selection, argument forwarding and affected fixture compatibility
   before broad validation. A failed broad run returns to a focused reproduction first.
3. One observer per operation, reuse of current evidence and protection of a ready release from
   unrelated changes. New wrappers require a demonstrated missing capability.
4. One current task state; completed chronology moves to a dated record and old-head fields are
   replaced when the selected revision changes.

The next-stage targets are one successful broad pass after focused checks, zero repeated failures
of an already understood cause, and zero additional diagnostics without a named unresolved gate.
Track time to verified recovery rather than number of commands, documents or passing tests.
Future observations must establish whether these changes improve delivery; instructions alone
are not evidence of a performance gain.

Mandatory exact-SHA checks, native coverage, stopped-fleet scope authorization, immutable recovery
evidence and protection of uncertain external effects remain required. A shorter process must
come from preventing rework and deferring unrelated work.
