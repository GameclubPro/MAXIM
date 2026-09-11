# Bot Reliability Audit: 2026-09-11

## Scope And Evidence

This is a bounded production and source audit, not a guarantee that every bot
workflow is defect-free. It covers the six configured moderation bots, the isolated
Publik runtime, their shared MAX transport, webhook reconciliation, and queue health.
No participant was sanctioned, existing message deleted, chat setting changed, or
ambiguous publication retried for this audit.

Production observations around 11:02-11:10 UTC:

- All 13 API roles ran the exact current API image, without duplicate API roles.
- Ingress/admin readiness, Postgres, Redis, Publik heartbeat, OCR readiness, and
  the canonical mini app were available. All six moderation bot subscription
  snapshots were healthy and recorded recent ingress, with no missing update types.
- Initial queue lag was below one second. The initial 60-second action snapshot
  contained 1,557 operations and four failures; this is a sample, not an SLO result.
- The bounded 30-minute webhook report found 46 failed events. A separate sample
  of the ten newest failed jobs from each of 16 default shards contained 159 HTTP
  404 errors and one unavailable-author-access error. The sample includes older
  jobs and is not a full-fleet error count or proof of one common root cause.
- Logs included inaccessible messages, unavailable moderation permissions,
  `PUBLISHER_ACTOR_ACCESS_REQUIRED`, ambiguous publication verification, and
  refused replays of already-terminal member-action ledger entries.
- OCR sandbox restart count was three and stable during the monitor; the API roles
  themselves had no restarts. The cause of earlier sandbox recycling was not proven.
- Available Docker disk capacity was approximately 36 GiB, above the shared-image
  build floor but below the monitor's 40 GiB warning threshold. Some samples had
  elevated disk wait and swap activity; the short observation does not establish
  sustained host pressure.

## Prioritized Plan

| Priority | Finding                                                                                              | Change / Acceptance Check                                                                                                                                                         | Status                                 |
| -------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P1       | Moderation webhook secret changes were ignored when the previous secret was no longer configured.    | Compare the stored secret fingerprint even with one configured secret; upsert without deleting the current subscription.                                                          | Implemented; regression tested.        |
| P1       | Redis failure while reporting a reconciliation failure could reject an unobserved periodic promise.  | Make failure reporting best effort in both moderation and Publisher reconcilers; prove that the next cycle can run.                                                               | Implemented; regression tested.        |
| P2       | Exact-message reads forwarded `timeoutMs` to rate-limit admission but not the HTTP request.          | Apply the normalized HTTP timeout to list and direct fallback routes, including presence checks. Preserve conservative 404 semantics.                                             | Implemented; regression tested.        |
| P2       | Publik performed three subscription GETs even when nothing changed.                                  | Use one GET in steady state; re-read after upsert and after obsolete-target deletion. Preserve identity attestation and target-before-delete ordering.                            | Implemented; regression tested.        |
| P1       | Individual entities cannot execute moderation or Publik publication without fresh authorized access. | Diagnose exact entity/bot access using the existing cabinet; an authorized administrator restores rights/binding where intended. Never borrow another profile's access.           | Still requires per-entity resolution.  |
| P2       | Repeated 404 verification and terminal/ambiguous action replays remain in production samples.        | Correlate bounded failures with the exact operation and durable intent before selecting recovery. Do not turn arbitrary 404 into success, clear fences, or mass-retry sends/bans. | Not resolved by these transport fixes. |
| P2       | Host pressure and earlier sandbox recycling need a longer observation.                               | Monitor across a real busy period; compare queue lag, action latency, disk wait, restart deltas, and free disk. Use manifest-aware reclaim only after inventory review.           | Follow-up observation required.        |

## Validation And Delivery

Baseline `npm run check:api` passed: 521 suites, 11,664 tests, typecheck and build.
Fourteen suites / 59 tests were skipped by their environment gates; the commercial
benchmark is deliberately outside this API CI command.

After the fixes, the three focused suites passed 342 tests. The fixture-based
multi-bot route smoke passed 22 assertions, including denied primary, draining
standby, and channel-specific delete permissions. It does not mutate MAX and does
not replace live workflow acceptance tests.

Required release sequence:

1. Run staged-impact static, documentation, and complete API checks.
2. Push only the audited runtime/tests/report, preserving unrelated agent notes.
3. Require green exact-SHA `Required` and `Analyze JavaScript and TypeScript` CI.
4. Deploy `api-shared` through the guarded VPS wrapper, covering all 13 API roles
   and OCR auxiliary. Do not recreate Postgres/Redis or rebuild static components.
5. Verify strict smokes, exact-image convergence, released webhook queue fence,
   and a bounded post-release monitor. The release manifest, not this report,
   records successful deployment.

The current MAX documentation site could not be retrieved from the local audit
environment because DNS resolution timed out. No endpoint, permission, webhook
update-type, or response-success contract was changed based on an assumption.

## Remaining Acceptance Boundaries

Timeouts here are per HTTP request, not one absolute deadline across a batch.
The three-to-one request reduction applies only to unchanged Publik subscription
checks; no global latency or throughput improvement is claimed without measurement.
Existing failed jobs and ambiguous outcomes remain available for diagnosis.
Live end-to-end moderation/publication acceptance must use only the designated
test chat/channel and uniquely marked test content while production is healthy.
