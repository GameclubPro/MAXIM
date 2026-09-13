# Publik Scheduled Publication Reliability Review

## Scope And Evidence

Reviewed Publication schedule normalization, occurrence materialization, Publisher wakeups,
bounded deadline polling, actor authorization, delivery recovery, MAX send ambiguity guards,
recurrence extension, and the separate VK publish scheduler/recovery path.

The initial production health sample was healthy with no current webhook queue lag. A bounded
Publisher log sample showed two execution envelopes repeatedly deferred with
`PUBLISHER_ACTOR_ACCESS_REQUIRED`. This proves persistent access blocking, not its underlying
cause: that guard combines actor edge freshness, role, binding, entity type, and publication
policy. No user content was exported, no historical delivery was reset, and no ad hoc production
SQL was executed. Individual complaints cannot be correlated without exact publication IDs.

## Findings And Changes

1. Recurrence preparation treated transient Prisma failures as permanent schedule corruption.
   A pool/transaction/connection timeout could set both schedule and publication to `ERROR`,
   preventing subsequent scheduled posts. Transient preparation errors now preserve the active
   schedule; the normal bounded poll retries it. Permanent failures retain the observed schedule
   revision and materialization timestamp fence before changing state.
2. Scheduled target resolution reused interactive recipient validation. An expired or missing
   Publisher access edge could produce a `BadRequestException`, fail the occurrence, and cancel
   the remaining schedule. Background-only resolution now records a recoverable Publisher
   blocker. Interactive creation and editing remain strict. Dynamic audiences remain dynamic.
3. The execution guard only reread unavailable author access. It did not nominate a targeted
   refresh, so recovery depended on catalog/background discovery or a manual user action.
   Persisted targets can now enqueue `stale_user_access` on the existing Publisher refresh queue.
   The request is bounded, exact-bot/exact-user scoped, deduplicated by the existing queue, and
   respects fresh grants and denials. Only the existing MAX-verified lifecycle-fenced worker can
   grant access. Disabled dispatch nominates no probes; publication policy is never changed.
4. Author access for every original target ran before delivery recovery, even for already sent
   recipients. Expiry or access loss after a successful send could block its rollup and the
   remaining recipients. Publisher receipt recovery now precedes authorization, which applies
   only to remaining `PENDING` recipients. Terminal deliveries are rolled up before content/media
   preparation, so unavailable old assets cannot invalidate an already persisted outcome.
   Legacy compatibility behavior is unchanged.

## Execution Plan

- [x] Inspect code paths and bounded production health/log evidence.
- [x] Implement reversible preparation deferral and targeted actor-access recovery.
- [x] Separate already persisted delivery results from new-send authorization.
- [x] Add regression tests for database failures, access deferral, exact refresh scope,
      disabled dispatch, partial delivery, and receipt-only recovery.
- [x] Complete broad API validation and source/build guards.
- [x] Push only owned files; wait for green exact-SHA required CI checks.
- [x] Deploy the shared API image through the guarded VPS wrapper and verify strict smokes.

## Validation And Delivery

- `npm run check:api`: 532 passing suites and 11,922 passing tests; 17 suites / 84 tests
  skipped by local integration-environment gates. API typecheck and production build passed.
- `npm run check:static`: lint, refactor guards, and all 492 tooling tests passed.
- Documentation and formatting checks, plus `git diff --check`, passed.
- All 35 focused mini app calendar, schedule-field, and planner tests passed.
- Exact runtime commit: `e559773096c30ee56b8a1631ac86e65a608b4aa7`. Both `Required` and
  `Analyze JavaScript and TypeScript` passed. The CI run also passed PostgreSQL race tests,
  Redis flow checks, all application checks, and immutable Docker image builds.
- The checksum-verified CI API image was preloaded through `vps-connect.sh preload-ci-image`;
  `vps-connect.sh deploy main --auto` updated every shared API role without rebuilding on the VPS.
  There were no pending migrations. Stateful and static services were not recreated.
- Release manifest: `release-20260913T123931Z-e559773096c3`. Local ingress/admin live and ready,
  public live, and isolated OCR/runtime smokes passed. The protected queue pause was released
  only after exact-image verification; readiness recovered as the backlog drained.
- The first post-deploy Publisher log sample showed both previously actor-blocked envelopes
  reaching post-send verification with existing remote message IDs. MAX returned inconclusive
  HTTP 404 responses, so verification was deferred with backoff; this is not proof of message
  absence or a successful new send. No automatic resend was introduced.
- The pre-existing user edit in `apps/api/AGENTS.md` was preserved and excluded from the commit.

## Recovery Boundaries

- Do not reset `SENT` or `AMBIGUOUS` deliveries or send-attempt ledger identities. A MAX send
  timeout is not proof of failure. This change does not replay historical uncertain sends.
- Previously terminalized `ERROR` schedules are not globally reactivated. Review exact affected
  publications and their receipts before any explicit retry; the patch prevents new accidental
  terminalization and permits existing active blocked work to recover normally.
- A disabled publication policy, removed bot, or a genuinely denied actor still blocks delivery.
  Multiple remaining recipients still require valid actor authorization as a group.
- VK autopublish is separate. Its global/source enablement, quiet hours, quotas, persisted timing,
  and 24-hour automatic recovery freshness horizon can intentionally prevent automatic output.
  No VK policy or historical catch-up limit was changed in this task.
- No database schema, contract, frontend, token mounting, or runtime topology change is required.
