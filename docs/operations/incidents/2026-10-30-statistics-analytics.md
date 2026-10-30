# Selected statistics reads and exact coverage — 2026-10-30

The new internal `POST /api/v1/internal/statistics/analytics:read` keeps the existing
central contract version and adds analytics version 1. Its first page contains the
selected aggregates and optional owner history; continuation pages contain only
history. Public requests cannot obtain dated history or publication weekday/heatmap
breakdowns. Legacy central routes retain their contracts.
Successful authenticated status replies advertise `x-statistics-analytics-version: 1`
and `Cache-Control: no-store` without changing the legacy JSON schema. Release
preflight checks this capability together with the existing central readiness fields.

The old composition prepared permissions, read native facts and read stored facts in
different transactions and could choose different clocks. The analytics service now
uses one RepeatableRead snapshot, a SQL observation cutoff selected after snapshot
acquisition, selected source permissions, and a fresh authority/revision check after
releasing the snapshot. Signed cursors bind the original cutoff, filter, authority
fingerprint and UTC retention generation. Expiry never advances on another page.
Audience continuation reads retain the previous actual observation across gaps using
only the selected audience source; other metric reads stay within the page range.

The optional `x-statistics-read-budget-ms` header accepts an integer from 1 to 5000;
absence means 5000. Its monotonic deadline starts before body parsing. Each statement
receives a PostgreSQL timeout from the remaining phase budget, with a reserve for the
fresh final permission check. An aborted request cannot start another query.

Prisma `maxWait` does not remove a pending pg pool acquisition, and pg `query_timeout`
does not cancel running SQL. The scoped admission guard therefore suppresses the
ordinary admission retry and releases an expired borrow before Prisma can issue
BEGIN. At most 16 such admissions can wait per pool. A pending pg waiter drains within
the configured single pool timeout; an already running statement stops at its server
timeout. This is bounded cleanup, not immediate driver cancellation on disconnect.
Ordinary pool callers keep their existing admission policy.

A separate confirmed defect converted a one-microsecond gap in discovery coverage
into complete coverage and invented zero counts. Native PostgreSQL proofs now retain
their exact six-digit timestamps, and the native reader and calculator share an exact
interval union. Unknown hours remain unknown across even a one-microsecond gap.
Stored observations collected after the pinned cutoff are excluded before source
selection; current-hour aggregate contents cannot be reconstructed from such a row.

Focused evidence before release: the microsecond regression failed in both the pure
calculator and real PostgreSQL adapter before the correction, then the combined
calculator/native/analytics suite passed 44 tests. Separate focused HTTP/budget tests
passed, including literal route dispatch, request limits, cursor invalidation, current
revocation, actual `pg_sleep` cancellation and no late BEGIN after saturated-pool
Prisma maxWait. See the `stats-analytics-postgres`, `stats-analytics-calculator`,
`maxim-native-stats-postgres`, `stats-controller-http` and `stats-read-budget` specs.

This entry records local implementation and focused evidence. Exact-commit CI,
deployment, public-route verification and real-device acceptance are separate gates.
