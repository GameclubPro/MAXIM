# PostgreSQL I/O Queue Backlog - 2026-08-28

## Status

Resolved. The incident recovery release was `release-20260828T071405Z-e3c692bf467f` from source
`e3c692bf467f2c4eb01497e120851feed16d19e6`.

## Impact

- The durable webhook outbox peaked at 17,638 `RECEIVED` rows and the oldest observed lag exceeded
  80 minutes.
- Local readiness returned 503 while live health remained available.
- Publik dispatch failed closed while queue health was unavailable; it did not report ambiguous
  sends as successful.
- No webhook rows, BullMQ jobs, publication intents, or completed backup generations were deleted.

## Detection

The incident was detected through the queue-lag readiness check and confirmed with bounded process,
PostgreSQL activity, and host I/O observations. The decisive evidence was one long-running backup
backend reading `webhook_events`, high primary-disk I/O wait, and a separate long-running Publisher
recovery query over `audit_logs`.

## Timeline

- `03:33 UTC`: `maxim-postgres-backup.service` started an unthrottled logical dump on the sole
  primary.
- Around `05:55 UTC`: readiness was 503 and the durable outbox was growing faster than terminal
  processing.
- `05:59-06:00 UTC`: the backup timer and service were stopped; the orphaned exact `pg_dump`
  backend was terminated after PID, application, query class, and start time were revalidated.
- `06:04 UTC`: a response-induced whole-table status aggregate and its parallel workers were
  cancelled. It had added I/O pressure while diagnosing the incident.
- Around `06:09 UTC`: the repeating Publisher suggestion recovery scan was identified and
  cancelled by exact query fingerprint while a bounded watchdog protected the drain.
- The queue drained without deleting or reordering events. Exact-SHA CI images were preloaded
  because the VPS could not satisfy the clean API-build disk floor.
- The guarded recovery deploy recreated every shared API role and active static component on the
  exact reviewed image, passed strict API/OCR/static smokes, and committed the release manifest.
- Around `07:30 UTC`: automatic system mode returned to `normal` with queue lag back in the
  low-single-second range.

## Root Cause

The scheduled logical backup used `pg_dump --compress=6` without a stream rate limit, runtime queue
guard, hard deadline, unique cleanup identity, or shared deploy serialization. Unit-level nice/I/O
hints applied to the Docker client process did not bound the PostgreSQL backend doing the reads.
The dump spent more than two hours reading the largest durable tables and consumed enough primary
disk bandwidth to push enqueue throughput below ingress throughput.

## Contributing Causes

1. Publisher suggestion recovery used one parameterized Prisma query with `action IN` and JSON
   `OR` predicates. PostgreSQL could not prove the committed partial-index predicates, so a bounded
   result limit still required a large scan.
2. During response, an ad hoc `SELECT status, COUNT(*) ... GROUP BY status` ran without a statement
   timeout and allowed parallel workers. This violated the existing bounded-audit rule and made the
   queue temporarily grow faster.
3. The local infrastructure check silently skipped ShellCheck when the binary was absent, while CI
   always ran it. This caused two follow-up lint-only commits before the final exact SHA became
   deployable; no failed lint commit reached production.
4. Repeated rollout readiness waits could not succeed until the I/O causes were removed. Extending
   a timeout alone did not improve queue throughput.

Roster reconciliation was ruled out as a feedback loop: incoming MAX events create roster work,
but roster work does not create webhook events.

## Corrective Actions

- Publisher recovery now uses three literal, separately limited `UNION ALL` branches with keyset
  pagination. Unit guards reject the former `OR/action IN` shape, and PostgreSQL race validation
  requires the reviewed indexes in the actual plan.
- Scheduled backup now uses an install-free 1 MiB/s stream limiter, a 12-hour deadline, low-priority
  in-container execution, a unique `PGAPPNAME`, a readiness/queue watchdog, exact backend/process
  cleanup, atomic publication, its own lock, and the shared deploy lock.
- Backup remains disabled until an off-peak full run succeeds. Its real production preflight passed
  without starting `pg_dump`; the prior completed checksum-backed generation was preserved.
- Production database diagnostics use the fixed `postgres-audit` catalog. The runner is read-only,
  non-parallel, server- and wall-clock bounded, output-bounded, serialized, and uses an exact
  application identity. `monitor-readonly` uses the same bounded runner.
- Obvious raw database commands through `vps-connect exec` fail closed unless a human supplies both
  the explicit break-glass flag and a non-empty reason.
- Local infrastructure validation now runs ShellCheck through a pinned fallback instead of silently
  skipping it.

## Validation

- Local API validation passed 9,144 tests and the production build.
- Infrastructure validation, static agent-tool tests, ShellCheck, PostgreSQL races, CodeQL, and the
  exact-SHA `Required` check passed.
- All 13 API roles ran the exact release image with restart count zero.
- Publik reported exact runtime identity, a fresh enabled heartbeat, ready secrets, and no global
  pause. Suggestion, comment, VK publishing, and broadcast queues were empty; periodic binding
  refresh batches drained normally.
- System mode returned to `normal`; fresh queue observations were bounded to ordinary incoming work.

## Residual Boundary

Open follow-up: the privileged SSH principal has Docker access and is therefore effectively root.
Repository wrappers, role defaults, and instructions prevent accidental misuse but cannot contain a
deliberate bypass through a raw Docker command. A true security boundary requires a separate default
agent SSH principal with no shell, Docker group, or port forwarding and a root-owned forced-command
gateway; the current privileged credential must remain human break-glass only.

This document intentionally contains no tokens, secret environment values, chat/user identifiers,
payloads, or message text.
