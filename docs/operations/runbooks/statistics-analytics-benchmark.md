# Canonical statistics analytics benchmark

The maintained synthetic benchmark calls the real `StatsAnalyticsService`,
`StatsReadService` and native adapter against disposable PostgreSQL. It lives under
`apps/api/test`, which the API runtime build excludes. It neither changes deployed
services nor calls MAX. The existing marketplace catalog benchmark remains a
separate release gate with its original workload and limits.

Run from the repository root with Node 24 and installed locked dependencies:

```sh
node scripts/agent/with-test-stores.mjs --migrate -- \
  npm test --workspace @maxim/api -- -- -- \
  --runTestsByPath test/benchmark-statistics-analytics.spec.ts
```

The public wrapper creates isolated PostgreSQL 16/Redis 7 stores, applies the real
schema and cleans up its stores. The benchmark independently refuses any host
other than loopback and any database name outside `maxim_race_test_<suffix>`;
connection-string host overrides are rejected. Without the wrapper database URL,
the native test is skipped and provides no performance evidence. No production
connection string or production fixture is needed.

## Fixed profile and acceptance

- 1,000 synthetic entities, 100 with 90 daily measurements each: 9,000 stored rows.
- Ten native channels with 2,160 posts each: 21,600 posts. Future posts verify the
  publication cutoff; independent direct SQL checks the selected publication count.
- 100 summary reads and 20 owner history reads, concurrency one, selecting
  `PUBLICATION_HOUR` for the ten dense channels. History must contain exactly 90
  distinct UTC dates and the preceding 90-day comparison is outside retention.
- Summary p95 must be at most 2,000 ms and p99 at most 5,000 ms. The profile and
  thresholds are fixed; shortening the run or retrying failed reads is not accepted.
- Each read has the native five-second budget; the whole benchmark has a twelve
  minute deadline, independent ten-second heartbeat and last successful sample.
- The strict response schema is checked. Executed SQL and returned rows are counted;
  actual measurement/native query shapes receive bounded
  `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)` on the disposable database.
  The plan guard rejects more than 500 visited measurement rows or 15,000 visited
  native posts. Only shape hashes, plan counts and index names enter the report.

Latency starts around the service call. `httpLatencyMeasured` is always `false`:
these results do not measure HTTP, marketplace composition, browser/network
latency, concurrent capacity or production behavior. Fixture size does not imply
that every entity is requested. This bounded profile is a regression guard for
selected 90-day reads, not a load-capacity claim.

## Verified local evidence, 2026-10-30

Against the canonical implementation at `61aae9f172bfccb82fb8f7bd1b28f3962ef32cd1`,
the focused native run completed three tests with no skips. Its 100 summary reads
measured p50 39.071 ms, p95 42.395 ms, p99 43.098 ms and maximum 57.968 ms.
Across 120 reads it counted 4,080 SQL calls and 269,280 returned rows. The largest
response was 118,878 bytes. The measurement plan visited 90 rows and native plans
visited 4,299 posts. The benchmark took approximately 28.1 seconds on the local
runner. These measurements are local evidence only; CI and production acceptance
are separate.

The guard tests reject a shortened summary sample, invalid latency, exceeded p95
or p99, and a plan scanning unrelated measurement history. Keep these guards and
the fixed profile when modifying the benchmark. The implementation is
[`benchmark-statistics-analytics.ts`](../../../apps/api/test/benchmark-statistics-analytics.ts)
and its executable native/guard suite is
[`benchmark-statistics-analytics.spec.ts`](../../../apps/api/test/benchmark-statistics-analytics.spec.ts).
