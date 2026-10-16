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
becomes success. The legacy `webhookLink=not_recorded` field does not imply complete provenance.
Optional per-reason `origin` evidence validates a new immutable source record against the exact
receipt, event/edit timestamp, message and canonical EXECUTION claim, including distinct receiving
and execution bots. Receipt retention produces `source_unavailable`; malformed evidence stays
invalid. Historical, deferred and other-message deletes are not backfilled. Only a newly inserted
reason records its source, atomically with that reason; conflict/promotion cannot replace it.
These routes provide no retry or mutation operation and retain the existing owner guard.

The owner-only `GET /v1/safety-desk/runtime/publication-cohort` observes PUBLIK_V1 occurrences
created in the closed fifteen-minute interval ending thirty seconds before the observation.
All seven statuses belong to the denominator, including canceled, failed and ambiguous outcomes.
The exact dispatch-profile/status/created-at/id B-tree bounds 513 heads and 512 scalar PK reads
per status. Schedule and content IDs are deduplicated; each content uses two indexed endpoint
probes and at most ten exact position reads. Overflow, negative positions and gaps remain UNKNOWN;
oversized content does not load asset payloads. No audience or recipient rows are read. Current revisions,
latest-content retries or insufficient historical evidence never fabricate acceptance-time mode/media.
Pending future, due, expired and unknown timing remain separate; due age excludes expired work.
Saved retry deadlines are validated before comparison with the original deadline. Occurrences
are not HTTP requests or individual recipients, and later manual retries are not separate members
of this creation cohort. No completion latency is inferred from `updatedAt`.

Publisher `publication_wait_v1` observations supplement existing timing logs; see
[Publisher diagnostics](../runbooks/publisher-publication-diagnostics.md). Logs are sampled
observations, not durable exactly-once counters or full accepted-operation denominators. The
acknowledgement-to-receipt interval starts at the existing wrapper observation. Separate
`publication_send_v1` monotonic observations measure the exact SEND HTTP boundary, successful
action-ledger CAS or exact readback, and winning recipient-receipt CAS. Missing remote IDs,
recovery-only returns and failed persistence do not invent local acknowledgement clocks. Nested
or detached actions cannot borrow another attempt's measurements; metrics contain fixed dimensions
without identities. Complete causal coverage of deferred DELETE, direct sanctions and other SEND
origins remains separate work; the new synchronous origin records do not prove that coverage.

Both schema changes are additive. The origin index is on a new empty table; the occurrence index
build is concurrent on retained history. No history rewrite, authority change or existing-reader
incompatibility is introduced. A compatible rollback may omit new observations while retaining
existing journals; it must not drop the additive tables or relax any installed rollback floor.

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
