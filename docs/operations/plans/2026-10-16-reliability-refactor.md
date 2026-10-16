# Reliability and latency refactor

## Sequential delivery

Keep one implementation/release stage active. Preserve current bot assignments, execution
ownership, rights checks, quotas, original deadlines and uncertain-effect fences.

1. Add read-only outcome evidence and Publisher waiting-time observations.
2. Separate ready publication work from receipt/blocker recovery with a bounded 3:1 budget,
   stable ordering and bounded recipient reads.
3. Persist versioned SQL continuations for comment recovery; lost Redis jobs must never turn
   an uncertain SEND into a replay. Drain owned operations before closing connections.
4. Extract Publisher scenarios, moderation handlers and MAX transport/admission/classification
   behind the existing public facades, checking decisions without executing effects twice.

Early webhook completion after recording a DELETE intent is excluded: existing sanction order
must remain intact. Do not treat the first observability release as completion of this plan.

## Stage 1 observation contract

The closed owner-only `GET /v1/safety-desk/runtime/webhook-cohort` observes receipts created
between 60 and 30 seconds before the database observation clock. It includes all eight saved
statuses, including quarantine, cancellation and no-replay holds. Each status has a 513-row
sentinel and at most 512 scalar metadata reads through primary keys. A cap produces an explicit
lower bound and incomplete coverage, never a complete denominator. An empty window is no proof
of healthy processing. The required status/created-at/id B-tree index is attested before reading;
statement and lock timeouts fail closed. Concurrent requests share a ten-second cache.

Receipt processing is not remote-effect proof. `effectsEvidence=not_linked` is deliberate:
existing journals do not always contain an authoritative receipt-to-intent causal ID. Elapsed
saved deadlines count as `expiredAtObservation` regardless of status, not failed actions. Timing
percentiles exclude invalid clocks and report their own sample counts. The endpoint does not
read message bodies or return user identifiers.

The on-demand `GET /v1/safety-desk/runtime/deletes/:intentId/evidence` reads one exact DELETE
intent, at most 32 reasons and 32 follow-ups plus sentinels, and notice ledgers through bounded
unique keys. It distinguishes finalized confirmed deletion, a MAX acknowledgement with unfinished
verification, documented message absence, unknown outcome, pending, stopped and observed-only states.
Remote success in an AMBIGUOUS intent remains `acknowledged`, never confirmed completion.
A saved moderation decision is not proof of a current sanction; its exact saved event timestamp
and follow-up identity must match. A notice receipt requires matching source, rule, policy, version and deadline, plus a
terminal successful nonambiguous receipt. Missing, malformed and conflicting evidence never
becomes success. `webhookLink=not_recorded` forbids guessed joins by chat/message/time. These
routes provide no retry or mutation operation and retain the existing owner guard.

Publisher `publication_wait_v1` observations supplement existing timing logs; see
[Publisher diagnostics](../runbooks/publisher-publication-diagnostics.md). Logs are sampled
observations, not durable exactly-once counters or full accepted-operation denominators. The
acknowledgement-to-receipt interval starts at the existing wrapper observation, not at the HTTP
socket boundary. Exact HTTP attribution and complete causal linkage remain explicit later work.

## Validation and acceptance

Run focused native PostgreSQL tests for caps, invalid clocks, index attestation, retained history,
exact receipt proof and bounded plans, then affected Publisher integration cases, contract tests,
Safety Desk client/browser checks and the impact-selected gates. Use disposable native stores;
never execute a benchmark or EXPLAIN ANALYZE on production. API/contract delivery requires all
roles of the shared image, exact-SHA Required and CodeQL, strict smokes and release identity.

Changed execution paths progress through verified test entities, 5% for at least 24 hours, 25%
for at least 24 hours, then 100% for 48 hours. Use stable entity cohorts. Read-only observation
routes do not switch effect ownership. Stop for a new duplicate effect, wrong sanction, bypassed
fence or lost receipt, or comparable-load p95/p99 deterioration over 10%. Missing samples mean
unfinished acceptance. Do not shorten observation windows or substitute queue health for effects.
