# Safe refactoring boundaries

The program preserves public API responses, callback payloads, queue envelopes, stored jobs,
authorization and the order of side effects. Each runtime slice has its own reviewed commit,
exact-SHA CI, scoped deployment and rollback-compatible observation window.

## Starting evidence

The API/UI baseline is `e4c960ad46369a68409b656efe7632f62adeec18`. Both required GitHub
checks passed. A fresh worktree installed the lockfile with Node 24.16.0 and ran
`node scripts/agent/with-test-stores.mjs --migrate -- npm run check` successfully.
The API reported 695 passing suites and 14,965 passing tests, with one skipped suite/test.
The mini app reported 1,451 passing tests and Safety Desk 21. Tooling's two opt-in skips
and the API skip are not claimed as test coverage. Production dependency audit reported
zero advisories. No original-worktree changes were copied into this baseline.

The production-origin mini app build measured these route budgets (gzip KiB, rounded):

| Route                      | JavaScript |  CSS |
| -------------------------- | ---------: | ---: |
| Startup                    |      123.7 | 33.5 |
| Chat settings, incremental |      142.8 | 71.5 |
| Publications, incremental  |      139.4 | 17.3 |

Rebuild with the same `VITE_API_BASE`, lockfile and budget definitions for comparisons.
Queue-lag samples are not HTTP latency measurements.

## Implemented boundaries

- `check:refactor-guards` also checks runtime context factories and legacy compatibility
  ports. The initial 16 exceptions pin existing definitions. Changed unsafe bridges fail;
  removed bridges require their exception to disappear. Never regenerate a growing baseline.
- Private settings search, summaries and buttons are pure functions. Their rendering corpus
  was captured from the baseline before extraction and passed against that implementation.
  Formatting is separate from Nest-dependent input parsing. The private facade retains
  callback/session orchestration and uses the same pure callback payload builder.

## Remaining release slices

1. Replace administrative runtime contexts domain by domain with explicit capabilities and
   preserve live getter identity, method receivers and initialization order.
2. Extract required-subscription state, settings draft/save ownership and rules editor state.
3. Separate publication browsing/calendar from editor lifecycle without changing request identity.
4. Extract night/manual-close message handling while retaining durable intent and claim ordering.
5. Measure independent optimization candidates after their structural release is stable.

For each slice, add missing behavior/race tests before moving the boundary; shrink the legacy
guard and relevant context exceptions afterwards. Real-store cases run through the public
validation wrappers. Browser scenarios exercise user actions and request results in addition
to architectural source checks. Retain current release source floors and observe strict
smokes plus at least 30 minutes of runtime health before the next production slice.
